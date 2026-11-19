import { describe, before, beforeEach, afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from 'sinon';
import timekeeper from 'timekeeper';

import bootstrap, { passInteractionChecks } from '../test_helper.js';
import { DEVICE_CODE_IN_FLIGHT_GRACE } from '../../lib/helpers/device_in_flight.js';

const sinon = createSandbox();
const route = '/device';

// Regression coverage for a confirmed-but-interrupted device code. The user
// agreed on the confirmation page and closed the browser before the success
// response rendered, leaving the record in-flight. Re-entering with the same
// user code must, within the grace box, surface the real state (never "code
// incorrect") and, once the grace box elapses, allow the flow to complete.
// Completing the flow must converge the stored record instead of leaving the
// transient in-flight state behind.
describe('interrupted confirmation re-entry (uf-t103)', () => {
  const fixture = {};

  before(bootstrap(import.meta.url, fixture), { timeout: 3000 });
  before(() => fixture.login({ scope: 'openid email' }), { timeout: 3000 });
  afterEach(() => {
    timekeeper.reset();
    sinon.restore();
  }, { timeout: 3000 });

  const xsrf = 'foo';

  beforeEach(() => {
    fixture.getSession().state = { secret: xsrf };
  }, { timeout: 3000 });

  passInteractionChecks(fixture, 'native_client_prompt', 'op_claims_missing', () => {
    const fixture1 = Object.create(fixture);

    async function interruptedCode() {
      const jti = await new fixture1.provider.DeviceCode({
        clientId: 'client',
        userCode: 'FOO',
        params: {
          scope: 'openid email',
          client_id: 'client',
        },
      }).save();

      // Simulate the moment the user clicked "Continue" and the tab died:
      // the lock was persisted but deviceVerificationResponse never ran.
      const code = await fixture1.provider.DeviceCode.find(jti);
      code.inFlight = true;
      code.inFlightAt = Math.floor(Date.now() / 1000);
      await code.save();

      return jti;
    }

    it('within the grace box re-entry reports the pending state, not an incorrect code', { timeout: 3000 }, async () => {
      const jti = await interruptedCode();

      await fixture1.agent.post(route)
        .send({
          xsrf,
          confirm: 'yes',
          user_code: 'FOO',
        })
        .type('form')
        .expect(200)
        .expect(/Your confirmation is still being processed\. Wait a moment and enter the code again/);

      const stored = await fixture1.provider.DeviceCode.find(jti);
      assert.equal(stored.inFlight, true);
      assert.equal(stored.accountId, undefined);
    });

    it('within the grace box the code is never treated as already used or incorrect', { timeout: 3000 }, async () => {
      await interruptedCode();
      const spy = sinon.spy(i(fixture1.provider).features.deviceFlow, 'userCodeInputSource');

      await fixture1.agent.post(route)
        .send({
          xsrf,
          user_code: 'FOO',
        })
        .type('form')
        .expect(200);

      sinon.assert.calledWithMatch(spy, sinon.match.any, sinon.match.any, sinon.match.any, sinon.match((err) => {
        assert.equal(err.name, 'PendingConfirmationError');
        return true;
      }));
    });

    it('after the grace box re-entry takes over and completes the flow', { timeout: 3000 }, async () => {
      const jti = await interruptedCode();

      timekeeper.travel(Date.now() + (DEVICE_CODE_IN_FLIGHT_GRACE * 1000));

      await fixture1.agent.post(route)
        .send({
          xsrf,
          confirm: 'yes',
          user_code: 'FOO',
        })
        .type('form')
        .expect(200);

      const stored = await fixture1.provider.DeviceCode.find(jti);
      assert.notEqual(stored.accountId, undefined);
      assert.equal(stored.inFlight, undefined);
      assert.equal(stored.inFlightAt, undefined);
    });

    it('after the grace box re-entry without confirm renders the confirmation page again', { timeout: 3000 }, async () => {
      await interruptedCode();

      timekeeper.travel(Date.now() + (DEVICE_CODE_IN_FLIGHT_GRACE * 1000));

      await fixture1.agent.post(route)
        .send({
          xsrf,
          user_code: 'FOO',
        })
        .type('form')
        .expect(200)
        .expect(new RegExp(`<form id="op.deviceConfirmForm" method="post" action="http://127.0.0.1:\\d+${fixture1.suitePath('/device')}">`));
    });

    it('a successful confirmation converges the record with no in-flight trace', { timeout: 3000 }, async () => {
      const jti = await new fixture1.provider.DeviceCode({
        clientId: 'client',
        userCode: 'BAR',
        params: {
          scope: 'openid email',
          client_id: 'client',
        },
      }).save();

      await fixture1.agent.post(route)
        .send({
          xsrf,
          confirm: 'yes',
          user_code: 'BAR',
        })
        .type('form')
        .expect(200);

      const stored = await fixture1.provider.DeviceCode.find(jti);
      assert.notEqual(stored.accountId, undefined);
      assert.equal(stored.inFlight, undefined);
      assert.equal(stored.inFlightAt, undefined);
    });

    it('keeps concurrent double confirmation locked while the first request is live', { timeout: 3000 }, async () => {
      await interruptedCode();
      const spy = sinon.spy(i(fixture1.provider).features.deviceFlow, 'userCodeInputSource');

      // No clock travel: the lock is younger than the grace box, so a second
      // concurrent confirmation must not be able to take the code over.
      await fixture1.agent.post(route)
        .send({
          xsrf,
          confirm: 'yes',
          user_code: 'FOO',
        })
        .type('form')
        .expect(200);

      sinon.assert.calledWithMatch(spy, sinon.match.any, sinon.match.any, sinon.match.any, sinon.match((err) => {
        assert.equal(err.name, 'PendingConfirmationError');
        return true;
      }));
    });

    it('after the grace box re-entry can still abort the interrupted flow with no lock left', { timeout: 3000 }, async () => {
      const jti = await interruptedCode();

      timekeeper.travel(Date.now() + (DEVICE_CODE_IN_FLIGHT_GRACE * 1000));

      await fixture1.agent.post(route)
        .send({
          xsrf,
          confirm: '',
          abort: 'yes',
          user_code: 'FOO',
        })
        .type('form')
        .expect(200)
        .expect(/The Sign-in request was interrupted/);

      const stored = await fixture1.provider.DeviceCode.find(jti);
      assert.equal(stored.error, 'access_denied');
      assert.equal(stored.inFlight, undefined);
      assert.equal(stored.inFlightAt, undefined);
      assert.equal(stored.accountId, undefined);
    });
  });
});

describe('state-specific re-render copy (uf-t103)', () => {
  const fixture2 = {};

  before(bootstrap(import.meta.url, fixture2), { timeout: 3000 });
  before(() => fixture2.login(), { timeout: 3000 });
  afterEach(() => {
    timekeeper.reset();
    sinon.restore();
  }, { timeout: 3000 });

  const xsrf = 'foo';

  beforeEach(() => {
    fixture2.getSession().state = { secret: xsrf };
  }, { timeout: 3000 });

  it('uses distinct copy for an expired code', { timeout: 3000 }, async () => {
    await new fixture2.provider.DeviceCode({ userCode: 'EXPIRED' }).save();
    timekeeper.travel(Date.now() + (((10 * 60) + 10) * 1000));

    await fixture2.agent.post(route)
      .send({ xsrf, user_code: 'EXPIRED' })
      .type('form')
      .expect(200)
      .expect(/This code has expired\. Start the sign-in again on your device/);
  });

  it('uses distinct copy for an already used code', { timeout: 3000 }, async () => {
    await new fixture2.provider.DeviceCode({
      userCode: 'USED',
      accountId: 'account',
    }).save();

    await fixture2.agent.post(route)
      .send({ xsrf, user_code: 'USED' })
      .type('form')
      .expect(200)
      .expect(/This code has already been used and cannot be confirmed again/);
  });

  it('keeps the incorrect-code copy for a not-found code', { timeout: 3000 }, async () => {
    await fixture2.agent.post(route)
      .send({ xsrf, user_code: 'DOES-NOT-EXIST' })
      .type('form')
      .expect(200)
      .expect(/The code you entered is incorrect\. Try again/);
  });
});

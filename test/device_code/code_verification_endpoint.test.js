import { describe, before, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from 'sinon';
import timekeeper from 'timekeeper';

import nanoid from '../../lib/helpers/nanoid.js';
import epochTime from '../../lib/helpers/epoch_time.js';
import bootstrap, { passInteractionChecks } from '../test_helper.js';

const sinon = createSandbox();

const { any } = sinon.match;
const route = '/device';

describe('GET code_verification endpoint', () => {
  const fixture = {};

  before(bootstrap(import.meta.url, fixture), { timeout: 3000 });

  describe('when accessed without user_code in query (verification_uri)', () => {
    const fixture1 = Object.create(fixture);

    it('renders 200 OK end-user form with csrf', { timeout: 3000 }, () => fixture1.agent.get(route)
        .expect(200)
        .expect('content-type', 'text/html; charset=utf-8')
        .expect(() => {
          const { state: { secret } } = fixture1.getSession();
          assert.equal(typeof secret, 'string');
        })
        .expect(new RegExp(`<form id="op.deviceInputForm" novalidate method="post" action="http://127.0.0.1:\\d+${fixture1.suitePath('/device')}">`)));
  });

  describe('when accessed with user_code in query (verification_uri_complete)', () => {
    const fixture2 = Object.create(fixture);

    it('renders 200 OK self-submitting form with csrf and the value from uri', { timeout: 3000 }, () => {
      let secret;

      return fixture2.agent.get(route)
        .query({ user_code: '123-456-789' })
        .expect(200)
        .expect('content-type', 'text/html; charset=utf-8')
        .expect(/document.addEventListener\('DOMContentLoaded', function \(\) { document.forms\[0\].submit\(\) }\);/)
        .expect(({ text }) => {
          ({ state: { secret } } = fixture2.getSession());
          assert.match(text, new RegExp(`input type="hidden" name="xsrf" value="${secret}"`));
        })
        .expect(new RegExp(`<form method="post" action="http://127.0.0.1:\\d+${fixture2.suitePath('/device')}">`))
        .expect(/<input type="hidden" name="user_code" value="123-456-789"\/>/);
    });

    it('escapes the user_code values', { timeout: 3000 }, () => fixture2.agent.get(route)
        .query({ user_code: '&<>"\'123-456-789' })
        .expect(200)
        .expect('content-type', 'text/html; charset=utf-8')
        .expect(/<input type="hidden" name="user_code" value="&amp;&lt;&gt;&quot;&#39;123-456-789"\/>/));
  });
});

describe('POST code_verification endpoint w/o verification', () => {
  const fixture3 = {};

  before(bootstrap(import.meta.url, fixture3), { timeout: 3000 });
  before(() => fixture3.login(), { timeout: 3000 });
  afterEach(() => timekeeper.reset(), { timeout: 3000 });

  const xsrf = 'foo';

  beforeEach(() => {
    fixture3.getSession().state = { secret: xsrf };
  }, { timeout: 3000 });

  afterEach(() => {
    fixture3.provider.removeAllListeners('code_verification.error');
    sinon.restore();
  }, { timeout: 3000 });

  it('renders a confirmation page', { timeout: 3000 }, async () => {
    const spy = sinon.spy(i(fixture3.provider).features.deviceFlow, 'userCodeConfirmSource');
    const deviceInfo = {
      ip: '127.0.0.1',
      ua: 'foo',
    };

    await new fixture3.provider.DeviceCode({
      clientId: 'client',
      userCode: 'FOOCODE',
      deviceInfo,
    }).save();

    await fixture3.agent.post(route)
      .send({
        xsrf,
        user_code: 'FOO-CODE',
      })
      .type('form')
      .expect(200)
      .expect(new RegExp(`<form id="op.deviceConfirmForm" method="post" action="http://127.0.0.1:\\d+${fixture3.suitePath('/device')}">`));

    assert.equal(spy.calledOnce, true);
    sinon.assert.calledWithMatch(spy, any, any, sinon.match((client) => {
      assert.equal(client.clientId, 'client');
      return true;
    }), deviceInfo);
  });

  it('re-renders on no submitted code', { timeout: 3000 }, async () => {
    const errSpy = sinon.spy();
    fixture3.provider.once('code_verification.error', errSpy);
    const spy = sinon.spy(i(fixture3.provider).features.deviceFlow, 'userCodeInputSource');

    await fixture3.agent.post(route)
      .send({ xsrf })
      .type('form')
      .expect(200)
      .expect(new RegExp(`<form id="op.deviceInputForm" novalidate method="post" action="http://127.0.0.1:\\d+${fixture3.suitePath('/device')}">`))
      .expect(/<p class="red">The code you entered is incorrect\. Try again<\/p>/);

    assert.equal(spy.calledOnce, true);
    sinon.assert.calledWithMatch(spy, any, any, any, sinon.match((err) => {
      assert.equal(err.name, 'NoCodeError');
      return true;
    }));

    ((actual) => { assert.ok('called' in Object(actual)); assert.equal(actual.called, false); })(errSpy);
  });

  it('re-renders on not found code', { timeout: 3000 }, async () => {
    const errSpy = sinon.spy();
    fixture3.provider.once('code_verification.error', errSpy);
    const spy = sinon.spy(i(fixture3.provider).features.deviceFlow, 'userCodeInputSource');

    await fixture3.agent.post(route)
      .send({
        xsrf,
        user_code: 'FOO-NOT-FOUND',
      })
      .type('form')
      .expect(200)
      .expect(new RegExp(`<form id="op.deviceInputForm" novalidate method="post" action="http://127.0.0.1:\\d+${fixture3.suitePath('/device')}">`))
      .expect(/<p class="red">The code you entered is incorrect\. Try again<\/p>/);

    assert.equal(spy.calledOnce, true);
    sinon.assert.calledWithMatch(spy, any, any, any, sinon.match((err) => {
      assert.equal(err.name, 'NotFoundError');
      return true;
    }));

    ((actual) => { assert.ok('called' in Object(actual)); assert.equal(actual.called, false); })(errSpy);
  });

  it('re-renders on found but expired code', { timeout: 3000 }, async () => {
    const errSpy = sinon.spy();
    fixture3.provider.once('code_verification.error', errSpy);
    const spy = sinon.spy(i(fixture3.provider).features.deviceFlow, 'userCodeInputSource');
    await new fixture3.provider.DeviceCode({
      userCode: 'FOOEXPIRED',
    }).save();

    timekeeper.travel(Date.now() + (((10 * 60) + 10) * 1000));
    await fixture3.agent.post(route)
      .send({
        xsrf,
        user_code: 'FOO-EXPIRED',
      })
      .type('form')
      .expect(200)
      .expect(new RegExp(`<form id="op.deviceInputForm" novalidate method="post" action="http://127.0.0.1:\\d+${fixture3.suitePath('/device')}">`))
      .expect(/<p class="red">The code you entered is incorrect\. Try again<\/p>/);

    assert.equal(spy.calledOnce, true);
    sinon.assert.calledWithMatch(spy, any, any, any, sinon.match((err) => {
      assert.equal(err.name, 'ExpiredError');
      return true;
    }));

    ((actual) => { assert.ok('called' in Object(actual)); assert.equal(actual.called, false); })(errSpy);
  });

  it('re-renders on found but already user code', { timeout: 3000 }, async () => {
    const errSpy = sinon.spy();
    fixture3.provider.once('code_verification.error', errSpy);
    const spy = sinon.spy(i(fixture3.provider).features.deviceFlow, 'userCodeInputSource');
    await new fixture3.provider.DeviceCode({
      userCode: 'FOOCONSUMED',
      accountId: 'account',
    }).save();

    await fixture3.agent.post(route)
      .send({
        xsrf,
        user_code: 'FOO-CONSUMED',
      })
      .type('form')
      .expect(200)
      .expect(new RegExp(`<form id="op.deviceInputForm" novalidate method="post" action="http://127.0.0.1:\\d+${fixture3.suitePath('/device')}">`))
      .expect(/<p class="red">The code you entered is incorrect\. Try again<\/p>/);

    assert.equal(spy.calledOnce, true);
    sinon.assert.calledWithMatch(spy, any, any, any, sinon.match((err) => {
      assert.equal(err.name, 'AlreadyUsedError');
      return true;
    }));

    ((actual) => { assert.ok('called' in Object(actual)); assert.equal(actual.called, false); })(errSpy);
  });

  it('re-renders on invalid client', { timeout: 3000 }, async () => {
    const errSpy = sinon.spy();
    fixture3.provider.once('code_verification.error', errSpy);
    const spy = sinon.spy(i(fixture3.provider).features.deviceFlow, 'userCodeInputSource');
    await new fixture3.provider.DeviceCode({
      userCode: 'FOONOTFOUNDCLIENT',
      clientId: 'client',
    }).save();

    sinon.stub(fixture3.provider.Client, 'find').callsFake(async () => { });
    await fixture3.agent.post(route)
      .send({
        xsrf,
        user_code: 'FOO-NOT-FOUND-CLIENT',
      })
      .type('form')
      .expect(400)
      .expect(new RegExp(`<form id="op.deviceInputForm" novalidate method="post" action="http://127.0.0.1:\\d+${fixture3.suitePath('/device')}">`))
      .expect(/<p class="red">There was an error processing your request<\/p>/);

    assert.equal(spy.calledOnce, true);
    sinon.assert.calledWithMatch(spy, any, any, any, sinon.match((err) => {
      assert.equal(err.name, 'InvalidClient');
      return true;
    }));

    assert.equal(errSpy.calledOnce, true);
  });

  it('re-renders on !ctx.oidc.session.state', { timeout: 3000 }, async () => {
    const errSpy = sinon.spy();
    fixture3.provider.once('code_verification.error', errSpy);
    const spy = sinon.spy(i(fixture3.provider).features.deviceFlow, 'userCodeInputSource');
    await new fixture3.provider.DeviceCode({
      userCode: 'FOOCSRF1',
    }).save();

    delete fixture3.getSession().state;
    await fixture3.agent.post(route)
      .send({
        xsrf,
        user_code: 'FOO-CSRF-1',
      })
      .type('form')
      .expect(400)
      .expect(new RegExp(`<form id="op.deviceInputForm" novalidate method="post" action="http://127.0.0.1:\\d+${fixture3.suitePath('/device')}">`))
      .expect(/<p class="red">There was an error processing your request<\/p>/);

    assert.equal(spy.calledOnce, true);
    sinon.assert.calledWithMatch(spy, any, any, any, sinon.match((err) => {
      assert.equal(err.name, 'InvalidRequest');
      assert.equal(err.error_description, 'could not find device form details');
      return true;
    }));

    assert.equal(errSpy.calledOnce, true);
  });

  it('re-renders on invalid csrf', { timeout: 3000 }, async () => {
    const errSpy = sinon.spy();
    fixture3.provider.once('code_verification.error', errSpy);
    const spy = sinon.spy(i(fixture3.provider).features.deviceFlow, 'userCodeInputSource');
    await new fixture3.provider.DeviceCode({
      userCode: 'FOOCSRF2',
    }).save();

    await fixture3.agent.post(route)
      .send({
        xsrf: 'invalid-csrf',
        user_code: 'FOO-CSRF-FOO',
      })
      .type('form')
      .expect(400)
      .expect(new RegExp(`<form id="op.deviceInputForm" novalidate method="post" action="http://127.0.0.1:\\d+${fixture3.suitePath('/device')}">`))
      .expect(/<p class="red">There was an error processing your request<\/p>/);

    assert.equal(spy.calledOnce, true);
    sinon.assert.calledWithMatch(spy, any, any, any, sinon.match((err) => {
      assert.equal(err.name, 'InvalidRequest');
      assert.equal(err.error_description, 'xsrf token invalid');
      return true;
    }));

    assert.equal(errSpy.calledOnce, true);
  });
});

describe('POST code_verification endpoint w/ verification', () => {
  const fixture4 = {};

  before(bootstrap(import.meta.url, fixture4), { timeout: 3000 });
  before(() => fixture4.login({
      scope: 'openid email',
      rejectedClaims: ['email_verified'],
    }), { timeout: 3000 });
  afterEach(() => timekeeper.reset(), { timeout: 3000 });
  afterEach(() => sinon.restore(), { timeout: 3000 });

  const xsrf = 'foo';

  beforeEach(() => {
    fixture4.getSession().state = { secret: xsrf };
  }, { timeout: 3000 });

  passInteractionChecks(fixture4, 'native_client_prompt', 'op_claims_missing', () => {
    const fixture5 = Object.create(fixture4);

    it('accepts an abort command', { timeout: 3000 }, async () => {
      const spy = sinon.spy(i(fixture5.provider).features.deviceFlow, 'userCodeInputSource');

      let code = await new fixture5.provider.DeviceCode({
        clientId: 'client',
        userCode: 'FOO',
        params: {
          scope: 'openid email',
          client_id: 'client',
          claims: JSON.stringify({ userinfo: { email: null } }),
        },
      }).save();

      await fixture5.agent.post(route)
        .send({
          xsrf,
          confirm: '',
          abort: 'yes',
          user_code: 'FOO',
        })
        .type('form')
        .expect(200)
        .expect(/The Sign-in request was interrupted/);

      code = await fixture5.provider.DeviceCode.find(code);

      assert.ok(!('accountId' in Object(code)));
      ((actual) => { assert.ok('error' in Object(actual)); assert.equal(actual.error, 'access_denied'); })(code);
      ((actual) => { assert.ok('errorDescription' in Object(actual)); assert.equal(actual.errorDescription, 'End-User aborted interaction'); })(code);

      assert.equal(spy.calledOnce, true);
    });

    it('renders a confirmation and assigns', { timeout: 3000 }, async () => {
      const spy = sinon.spy(i(fixture5.provider).features.deviceFlow, 'successSource');

      let code = await new fixture5.provider.DeviceCode({
        clientId: 'client',
        userCode: 'FOO',
        params: {
          scope: 'openid email',
          client_id: 'client',
          claims: JSON.stringify({ userinfo: { email: null } }),
        },
      }).save();

      await fixture5.agent.post(route)
        .send({
          xsrf,
          confirm: 'yes',
          user_code: 'FOO',
        })
        .type('form')
        .expect(200);

      code = await fixture5.provider.DeviceCode.find(code);

      const session = fixture5.getSession();

      assert.ok(!('sid' in Object(code)));
      ((actual) => { assert.ok('accountId' in Object(actual)); assert.equal(actual.accountId, session.accountId); })(code);
      ((actual) => { assert.ok('authTime' in Object(actual)); assert.equal(actual.authTime, session.loginTs); })(code);
      ((actual) => { assert.ok('scope' in Object(actual)); assert.equal(actual.scope, 'openid email'); })(code);
      ((actual) => { assert.ok('claims' in Object(actual)); assert.deepEqual(actual.claims, { userinfo: { email: null } }); })(code);

      assert.equal(spy.calledOnce, true);
    });

    it('renders a confirmation and assigns (incl. sid because of client configuration)', { timeout: 3000 }, async () => {
      const spy = sinon.spy(i(fixture5.provider).features.deviceFlow, 'successSource');

      let code = await new fixture5.provider.DeviceCode({
        clientId: 'client-backchannel',
        userCode: 'FOO',
        params: {
          scope: 'openid',
          client_id: 'client-backchannel',
        },
      }).save();

      await fixture5.agent.post(route)
        .send({
          xsrf,
          confirm: 'yes',
          user_code: 'FOO',
        })
        .type('form')
        .expect(200);

      code = await fixture5.provider.DeviceCode.find(code);

      assert.ok('sid' in Object(code));
      assert.equal(spy.calledOnce, true);
    });

    it('renders a confirmation and assigns (incl. sid because of claims)', { timeout: 3000 }, async () => {
      const spy = sinon.spy(i(fixture5.provider).features.deviceFlow, 'successSource');

      let code = await new fixture5.provider.DeviceCode({
        clientId: 'client',
        userCode: 'FOO',
        params: {
          scope: 'openid',
          client_id: 'client',
          claims: JSON.stringify({ id_token: { sid: null } }),
        },
      }).save();

      await fixture5.agent.post(route)
        .send({
          xsrf,
          confirm: 'yes',
          user_code: 'FOO',
        })
        .type('form')
        .expect(200);

      code = await fixture5.provider.DeviceCode.find(code);

      assert.ok('sid' in Object(code));
      assert.equal(spy.calledOnce, true);
    });

    it('allows for punctuation to be included and characters to be downcased', { timeout: 3000 }, async () => {
      const spy = sinon.spy(i(fixture5.provider).features.deviceFlow, 'successSource');

      let code = await new fixture5.provider.DeviceCode({
        clientId: 'client',
        userCode: 'FOOBAR',
        params: {
          scope: 'openid email',
          client_id: 'client',
          claims: JSON.stringify({ userinfo: { email: null } }),
        },
      }).save();

      await fixture5.agent.post(route)
        .send({
          xsrf,
          confirm: 'yes',
          user_code: 'f o o b a r',
        })
        .type('form')
        .expect(200);

      code = await fixture5.provider.DeviceCode.find(code);

      const session = fixture5.getSession();

      ((actual) => { assert.ok('accountId' in Object(actual)); assert.equal(actual.accountId, session.accountId); })(code);
      ((actual) => { assert.ok('authTime' in Object(actual)); assert.equal(actual.authTime, session.loginTs); })(code);
      ((actual) => { assert.ok('scope' in Object(actual)); assert.equal(actual.scope, 'openid email'); })(code);
      ((actual) => { assert.ok('claims' in Object(actual)); assert.deepEqual(actual.claims, { userinfo: { email: null } }); })(code);

      assert.equal(spy.calledOnce, true);
    });
  });
});

describe('POST code_verification endpoint re-entry after an interrupted confirmation', () => {
  const fixture6 = {};

  before(bootstrap(import.meta.url, fixture6), { timeout: 3000 });
  before(() => fixture6.agent.get(route), { timeout: 3000 }); // establish a session
  afterEach(() => timekeeper.reset(), { timeout: 3000 });
  afterEach(() => sinon.restore(), { timeout: 3000 });

  const xsrf = 'foo';

  beforeEach(() => {
    fixture6.getSession().state = { secret: xsrf };
  }, { timeout: 3000 });

  const params = { scope: 'openid', client_id: 'client' };

  function stuckCode(userCode, extra = {}) {
    return new fixture6.provider.DeviceCode({
      clientId: 'client',
      userCode,
      inFlight: true,
      params,
      ...extra,
    }).save();
  }

  it('redirects a re-entry to the still resumable interaction', { timeout: 3000 }, async () => {
    const uid = nanoid();
    const jti = await stuckCode('STUCKONE', { interactionUid: uid });
    await new fixture6.provider.Interaction(uid, {
      uid,
      deviceCode: jti,
      prompt: { name: 'login', reasons: ['no_session'], details: {} },
      params,
    }).save(600);

    await fixture6.agent.post(route)
      .send({ xsrf, user_code: 'STUCK-ONE' })
      .type('form')
      .expect(303)
      .expect('location', new RegExp(`/device/${uid}$`));

    // the in-flight marker is NOT released while the interaction is alive
    const code = await fixture6.provider.DeviceCode.findByUserCode('STUCKONE');
    assert.equal(code.inFlight, true);
    assert.equal(code.interactionUid, uid);
    assert.ok(!('accountId' in Object(code)));
  });

  it('redirects a repeated confirm submission to the in-flight interaction instead of starting a second authorization', { timeout: 3000 }, async () => {
    const uid = nanoid();
    const jti = await stuckCode('STUCKTWO', { interactionUid: uid });
    await new fixture6.provider.Interaction(uid, {
      uid,
      deviceCode: jti,
      prompt: { name: 'login', reasons: ['no_session'], details: {} },
      params,
    }).save(600);

    const spy = sinon.spy(i(fixture6.provider).features.deviceFlow, 'successSource');

    await fixture6.agent.post(route)
      .send({ xsrf, user_code: 'STUCK-TWO', confirm: 'yes' })
      .type('form')
      .expect(303)
      .expect('location', new RegExp(`/device/${uid}$`));

    // no second authorization ran and the code is untouched
    assert.equal(spy.called, false);
    const code = await fixture6.provider.DeviceCode.findByUserCode('STUCKTWO');
    assert.equal(code.inFlight, true);
    assert.equal(code.interactionUid, uid);
    assert.ok(!('accountId' in Object(code)));
  });

  it('releases the stale in-flight marker when the interaction session is gone and re-renders the confirmation', { timeout: 3000 }, async () => {
    const spy = sinon.spy(i(fixture6.provider).features.deviceFlow, 'userCodeConfirmSource');

    await stuckCode('STUCKTHREE', { interactionUid: 'gone' });

    await fixture6.agent.post(route)
      .send({ xsrf, user_code: 'STUCK-THREE' })
      .type('form')
      .expect(200)
      .expect(new RegExp(`<form id="op.deviceConfirmForm" method="post" action="http://127.0.0.1:\\d+${fixture6.suitePath('/device')}">`));

    assert.equal(spy.calledOnce, true);

    const code = await fixture6.provider.DeviceCode.findByUserCode('STUCKTHREE');
    assert.ok(!('inFlight' in Object(code)));
    assert.ok(!('interactionUid' in Object(code)));
  });

  it('releases an in-flight marker that never got an interaction session', { timeout: 3000 }, async () => {
    const spy = sinon.spy(i(fixture6.provider).features.deviceFlow, 'userCodeConfirmSource');

    await stuckCode('STUCKFOUR');

    await fixture6.agent.post(route)
      .send({ xsrf, user_code: 'STUCK-FOUR' })
      .type('form')
      .expect(200)
      .expect(new RegExp(`<form id="op.deviceConfirmForm" method="post" action="http://127.0.0.1:\\d+${fixture6.suitePath('/device')}">`));

    assert.equal(spy.calledOnce, true);

    const code = await fixture6.provider.DeviceCode.findByUserCode('STUCKFOUR');
    assert.ok(!('inFlight' in Object(code)));
  });

  it('lets a confirmation through once the stale marker is released', { timeout: 3000 }, async () => {
    await stuckCode('STUCKFIVE', { interactionUid: 'gone' });

    // logged out, so the released confirmation starts a fresh interaction
    await fixture6.agent.post(route)
      .send({ xsrf, user_code: 'STUCK-FIVE', confirm: 'yes' })
      .type('form')
      .expect(303)
      .expect('location', /\/interaction\//);

    const code = await fixture6.provider.DeviceCode.findByUserCode('STUCKFIVE');
    assert.equal(code.inFlight, true);
    assert.ok(code.interactionUid);
    assert.notEqual(code.interactionUid, 'gone');
    assert.ok(await fixture6.provider.Interaction.find(code.interactionUid));
  });

  it('allows an interrupted code to be aborted once its flow is gone', { timeout: 3000 }, async () => {
    await stuckCode('STUCKSIX');

    await fixture6.agent.post(route)
      .send({ xsrf, user_code: 'STUCK-SIX', abort: 'yes' })
      .type('form')
      .expect(200)
      .expect(/The Sign-in request was interrupted/);

    const code = await fixture6.provider.DeviceCode.findByUserCode('STUCKSIX');
    ((actual) => { assert.ok('error' in Object(actual)); assert.equal(actual.error, 'access_denied'); })(code);
    assert.ok(!('accountId' in Object(code)));
  });

  it('still rejects codes that already have a final outcome (error)', { timeout: 3000 }, async () => {
    const spy = sinon.spy(i(fixture6.provider).features.deviceFlow, 'userCodeInputSource');

    await new fixture6.provider.DeviceCode({
      clientId: 'client',
      userCode: 'STUCKSEVEN',
      error: 'access_denied',
      errorDescription: 'End-User aborted interaction',
      params,
    }).save();

    await fixture6.agent.post(route)
      .send({ xsrf, user_code: 'STUCK-SEVEN' })
      .type('form')
      .expect(200)
      .expect(/<p class="red">The code you entered is incorrect\. Try again<\/p>/);

    assert.equal(spy.calledOnce, true);
    sinon.assert.calledWithMatch(spy, any, any, any, sinon.match((err) => {
      assert.equal(err.name, 'AlreadyUsedError');
      return true;
    }));
  });

  it('still rejects expired in-flight codes as expired', { timeout: 3000 }, async () => {
    const spy = sinon.spy(i(fixture6.provider).features.deviceFlow, 'userCodeInputSource');

    await stuckCode('STUCKEIGHT');

    timekeeper.travel(Date.now() + (((10 * 60) + 10) * 1000));

    await fixture6.agent.post(route)
      .send({ xsrf, user_code: 'STUCK-EIGHT' })
      .type('form')
      .expect(200)
      .expect(/<p class="red">The code you entered is incorrect\. Try again<\/p>/);

    assert.equal(spy.calledOnce, true);
    sinon.assert.calledWithMatch(spy, any, any, any, sinon.match((err) => {
      assert.equal(err.name, 'ExpiredError');
      return true;
    }));
  });

  it('recovers the full flow after the End-User confirms and leaves mid-flow', { timeout: 3000 }, async () => {
    // the device gets its codes ...
    const deviceCode = new fixture6.provider.DeviceCode({
      clientId: 'client',
      userCode: 'STUCKNINE',
      params,
    });
    const deviceCodeValue = await deviceCode.save();

    // ... the End-User confirms and leaves before finishing the sign-in
    await fixture6.agent.post(route)
      .send({ xsrf, user_code: 'STUCK-NINE', confirm: 'yes' })
      .type('form')
      .expect(303)
      .expect('location', /\/interaction\//);

    let code = await fixture6.provider.DeviceCode.findByUserCode('STUCKNINE');
    assert.equal(code.inFlight, true);
    assert.ok(code.interactionUid);
    const { interactionUid } = code;

    // the device keeps polling and is told to keep waiting
    await fixture6.agent.post('/token')
      .type('form')
      .send({
        client_id: 'client',
        device_code: deviceCodeValue,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      })
      .expect(400)
      .expect((response) => {
        assert.equal(response.body.error, 'authorization_pending');
      });

    // the End-User comes back with the same code and is sent back to their flow
    fixture6.getSession().state = { secret: xsrf }; // the confirm POST consumed it
    await fixture6.agent.post(route)
      .send({ xsrf, user_code: 'STUCK-NINE' })
      .type('form')
      .expect(303)
      .expect('location', new RegExp(`/device/${interactionUid}$`));

    // the End-User finishes the sign-in (login + consent, the latter
    // persists the grant like the consent interaction would) ...
    const grant = new fixture6.provider.Grant({
      accountId: 'sub-stuck-nine',
      clientId: 'client',
    });
    grant.addOIDCScope('openid');
    const grantId = await grant.save();

    const interaction = await fixture6.provider.Interaction.find(interactionUid);
    Object.assign(interaction, {
      result: {
        login: { accountId: 'sub-stuck-nine', ts: epochTime() },
        consent: { grantId },
      },
    });
    await interaction.persist();

    await fixture6.agent.get(fixture6.suitePath(`/device/${interactionUid}`))
      .expect(200)
      .expect(/was successful/);

    code = await fixture6.provider.DeviceCode.findByUserCode('STUCKNINE');
    ((actual) => { assert.ok('accountId' in Object(actual)); assert.equal(actual.accountId, 'sub-stuck-nine'); })(code);

    // ... and the device's next poll is issued tokens
    await fixture6.agent.post('/token')
      .type('form')
      .send({
        client_id: 'client',
        device_code: deviceCodeValue,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      })
      .expect(200)
      .expect((response) => {
        assert.ok(response.body.access_token);
        assert.equal(response.body.token_type, 'Bearer');
      });
  });
});

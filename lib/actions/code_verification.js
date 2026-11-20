import sessionMiddleware from '../shared/session.js';
import paramsMiddleware from '../shared/assemble_params.js';
import { urlencoded as parseBody } from '../shared/selective_body.js';
import rejectDupes from '../shared/reject_dupes.js';
import instance from '../helpers/weak_cache.js';
import { InvalidClient } from '../helpers/errors.js';
import { generateXsrf, checkXsrf } from '../shared/xsrf.js';
import * as formHtml from '../helpers/user_code_form.js';
import formPost from '../response_modes/form_post.js';
import { normalize, denormalize } from '../helpers/user_codes.js';
import {
  NoCodeError, NotFoundError, ExpiredError, AlreadyUsedError, AbortedError,
} from '../helpers/re_render_errors.js';

export const get = [
  sessionMiddleware,
  paramsMiddleware.bind(undefined, new Set(['user_code'])),
  generateXsrf,
  async function renderCodeVerification(ctx) {
    const { charset, userCodeInputSource } = instance(ctx.oidc.provider).features.deviceFlow;

    const { secret } = ctx.oidc.session.state;
    const action = ctx.oidc.urlFor('code_verification');
    if (ctx.oidc.params.user_code) {
      formPost(ctx, action, {
        xsrf: secret,
        user_code: ctx.oidc.params.user_code,
      });
    } else {
      await userCodeInputSource(ctx, formHtml.input(action, secret, undefined, charset));
    }
  },
];

export const post = [
  sessionMiddleware,
  parseBody,
  paramsMiddleware.bind(undefined, new Set(['xsrf', 'user_code', 'confirm', 'abort'])),
  rejectDupes.bind(undefined, {}),

  checkXsrf('could not find device form details'),

  async function loadDeviceCodeByUserInput(ctx, next) {
    const { userCodeConfirmSource, mask } = instance(ctx.oidc.provider).features.deviceFlow;
    const { user_code: userCode, confirm, abort } = ctx.oidc.params;

    if (!userCode) {
      throw new NoCodeError();
    }

    const normalized = normalize(userCode);
    const code = await ctx.oidc.provider.DeviceCode.findByUserCode(
      normalized,
      { ignoreExpiration: true },
    );

    if (!code) {
      throw new NotFoundError(userCode);
    }

    if (code.isExpired) {
      throw new ExpiredError(userCode);
    }

    if (code.error || code.accountId) {
      throw new AlreadyUsedError(userCode);
    }

    if (code.inFlight) {
      // A previous confirmation was submitted but the authorization it
      // started never reached a final outcome (the End-User left mid-flow).
      const interaction = code.interactionUid
        ? await ctx.oidc.provider.Interaction.find(code.interactionUid)
        : undefined;

      if (interaction) {
        // The interrupted flow is still resumable — send the End-User back
        // to it rather than letting a second authorization run for the same
        // code. This redirect is what keeps the concurrent-confirmation
        // guard binding: while an authorization is genuinely in flight every
        // request for the code, including a repeated confirm submission, is
        // funnelled back into that single in-flight flow.
        ctx.status = 303;
        ctx.redirect(ctx.oidc.urlFor('device_resume', { uid: interaction.uid }));
        return;
      }

      // The interrupted flow can no longer be resumed (its interaction
      // session is gone, e.g. expired, or was never created because the
      // request died before reaching that point). Release the stale
      // in-flight marker so the code can be confirmed or aborted again
      // below instead of being stuck until it expires.
      delete code.inFlight;
      delete code.interactionUid;
      await code.save();
    }

    ctx.oidc.entity('DeviceCode', code);

    if (abort) {
      Object.assign(code, {
        error: 'access_denied',
        errorDescription: 'End-User aborted interaction',
      });

      await code.save();
      throw new AbortedError();
    }

    if (!confirm) {
      const client = await ctx.oidc.provider.Client.find(code.clientId);
      if (!client) {
        throw new InvalidClient('client is invalid', 'client not found');
      }
      ctx.oidc.entity('Client', client);

      const action = ctx.oidc.urlFor('code_verification');
      await userCodeConfirmSource(
        ctx,
        formHtml.confirm(action, ctx.oidc.session.state.secret, userCode),
        client,
        code.deviceInfo,
        denormalize(normalized, mask),
      );
      return;
    }

    code.inFlight = true;
    await code.save();

    await next();
  },

  function cleanup(ctx, next) {
    ctx.oidc.session.state = undefined;
    return next();
  },
];

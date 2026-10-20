import { expect, it } from 'vitest';
import { authErrorMessage } from '../../src/lib/client/auth-errors';
it('distinguishes email-sending limits, request limits and unconfigured delivery', () => {
  expect(authErrorMessage({ code: 'over_email_send_rate_limit' })).toContain('emails are temporarily limited');
  expect(authErrorMessage({ code: 'over_request_rate_limit' })).toContain('signup attempts');
  expect(authErrorMessage({ code: 'email_address_not_authorized' })).toContain('email-service setup');
  expect(authErrorMessage({ status: 429 })).toContain('Please wait');
});
it('never exposes raw provider errors or claims a fixed recovery time or successful delivery', () => {
  for (const error of [
    { message: 'secret token and private@example.test provider failure' },
    { code: 'unexpected_failure', message: 'secret token' },
    { code: 'over_email_send_rate_limit', message: 'secret token' },
  ]) {
    const message = authErrorMessage(error);
    expect(message).not.toContain('secret');
    expect(message).not.toContain('private@example.test');
    expect(message).not.toContain('30 minutes');
  }
  expect(authErrorMessage({ code: 'email_not_confirmed' })).toContain('Confirm your email');
});

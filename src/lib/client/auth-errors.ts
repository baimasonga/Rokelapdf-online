/** Public auth guidance. Never expose raw mail-provider errors, addresses or tokens. */
export function authErrorMessage(error: { code?: string; status?: number; message?: string }): string {
  switch (error.code) {
    case 'over_email_send_rate_limit':
      return 'Confirmation and password-reset emails are temporarily limited. Please wait before trying again. If this continues, contact support.';
    case 'over_request_rate_limit':
      return 'Too many sign-in or signup attempts. Please wait a little before trying again.';
    case 'email_address_not_authorized':
      return 'Email delivery is not available for this address yet. Please contact support so we can complete the email-service setup.';
    case 'email_not_confirmed':
      return 'Confirm your email using the link in your inbox before signing in. Check your spam folder too.';
    case 'invalid_credentials':
      return 'The email or password is incorrect.';
    case 'weak_password':
      return 'Use at least 10 characters, including an uppercase letter, a lowercase letter and a number.';
    case 'otp_expired':
    case 'flow_state_expired':
    case 'flow_state_not_found':
    case 'bad_code_verifier':
    case 'pkce_verifier_not_found':
    case 'auth_session_missing':
      return 'This account link is invalid or expired. Request a new link and open it in the same browser where you requested it.';
    case 'signup_disabled':
      return 'New account registration is temporarily unavailable. Please contact support.';
    case 'user_already_exists':
      return 'If you already have an account, sign in or use Forgot password.';
    case 'request_timeout':
      return 'The account service took too long to respond. Please try again shortly.';
    default:
      return error.status === 429
        ? 'Too many account requests. Please wait before trying again.'
        : 'We could not complete that account request. Please try again. If it continues, contact support.';
  }
}

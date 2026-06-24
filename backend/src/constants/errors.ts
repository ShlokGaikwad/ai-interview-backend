export const JoinError = {
  NOT_FOUND: 'not-found',
  COMPLETED: 'interview-completed',
  EXPIRED: 'link-expired',
  SERVER_ERROR: 'server-error',
} as const;

export type JoinErrorCode = typeof JoinError[keyof typeof JoinError];

export const InterviewError = {
  MISSING_FIELDS: 'missing-fields',
  SERVER_ERROR: 'server-error',
} as const;

export type InterviewErrorCode = typeof InterviewError[keyof typeof InterviewError];

export const AuthError = {
  MISSING_FIELDS: 'missing-fields',
  EMAIL_TAKEN: 'email-taken',
  INVALID_CREDENTIALS: 'invalid-credentials',
  UNAUTHORIZED: 'unauthorized',
  SERVER_ERROR: 'server-error',
} as const;

export type AuthErrorCode = typeof AuthError[keyof typeof AuthError];

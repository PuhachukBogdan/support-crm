import { SetMetadata } from '@nestjs/common';

/**
 * `@Public()` opts a route out of the global AuthGuard (feature 009). Only the auth-entry
 * endpoints and health probes may be public; everything else requires a validated session
 * (Principle II — no bypass). The guard reads this metadata key.
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

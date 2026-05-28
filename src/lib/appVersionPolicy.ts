export type AppPlatform = 'android' | 'ios';

export interface PlatformVersionPolicy {
  platform: AppPlatform;
  enabled: boolean;
  latestBuildNumber: number;
  minSupportedBuildNumber: number;
  storeUrl: string;
  message: string;
}

export interface AppVersionDecision {
  available: boolean;
  required: boolean;
}

export function evaluateAppVersionPolicy(
  policy: PlatformVersionPolicy,
  currentBuildNumber: number,
): AppVersionDecision {
  if (!policy.enabled || !Number.isFinite(currentBuildNumber) || currentBuildNumber < 0) {
    return { available: false, required: false };
  }

  const required = currentBuildNumber < policy.minSupportedBuildNumber;
  const available = required || currentBuildNumber < policy.latestBuildNumber;

  return { available, required };
}

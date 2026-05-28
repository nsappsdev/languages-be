import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { evaluateAppVersionPolicy } from '../lib/appVersionPolicy';
import type { AuthenticatedRequest } from '../middleware/authenticate';
import type { AppPlatform, PlatformVersionPolicy } from '../lib/appVersionPolicy';
import { prisma } from '../lib/prisma';

const router = Router();

const SETTINGS_ID = 'global';

const appVersionSettingsSelect = {
  updatePolicyEnabled: true,
  latestAndroidBuildNumber: true,
  minAndroidBuildNumber: true,
  latestIosBuildNumber: true,
  minIosBuildNumber: true,
  androidStoreUrl: true,
  iosStoreUrl: true,
  updateMessage: true,
} as const;

type AppVersionSettings = {
  updatePolicyEnabled: boolean;
  latestAndroidBuildNumber: number;
  minAndroidBuildNumber: number;
  latestIosBuildNumber: number;
  minIosBuildNumber: number;
  androidStoreUrl: string;
  iosStoreUrl: string;
  updateMessage: string;
};

const appVersionQuerySchema = z.object({
  platform: z.enum(['android', 'ios']),
  buildNumber: z.coerce.number().int().min(0),
});

function toPlatformPolicy(
  settings: AppVersionSettings,
  platform: AppPlatform,
): PlatformVersionPolicy {
  if (platform === 'android') {
    return {
      platform,
      enabled: settings.updatePolicyEnabled,
      latestBuildNumber: settings.latestAndroidBuildNumber,
      minSupportedBuildNumber: settings.minAndroidBuildNumber,
      storeUrl: settings.androidStoreUrl,
      message: settings.updateMessage,
    };
  }

  return {
    platform,
    enabled: settings.updatePolicyEnabled,
    latestBuildNumber: settings.latestIosBuildNumber,
    minSupportedBuildNumber: settings.minIosBuildNumber,
    storeUrl: settings.iosStoreUrl,
    message: settings.updateMessage,
  };
}

router.get('/app-version', authenticate, async (req: AuthenticatedRequest, res) => {
  const parsed = appVersionQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: 'Invalid query', issues: parsed.error.flatten() });
    return;
  }

  try {
    const settings = await prisma.appSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
      update: {},
      select: appVersionSettingsSelect,
    });
    const policy = toPlatformPolicy(settings, parsed.data.platform);
    const update = evaluateAppVersionPolicy(policy, parsed.data.buildNumber);

    res.json({
      currentBuildNumber: parsed.data.buildNumber,
      policy,
      update,
    });
  } catch {
    res.status(500).json({ message: 'Failed to load app version policy' });
  }
});

export { router as appVersionRouter };

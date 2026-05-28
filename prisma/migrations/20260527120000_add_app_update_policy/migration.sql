ALTER TABLE "AppSettings"
ADD COLUMN "updatePolicyEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "latestAndroidBuildNumber" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "minAndroidBuildNumber" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "latestIosBuildNumber" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "minIosBuildNumber" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "androidStoreUrl" TEXT NOT NULL DEFAULT 'https://play.google.com/store/apps/details?id=com.nsappsdev.language',
ADD COLUMN "iosStoreUrl" TEXT NOT NULL DEFAULT '',
ADD COLUMN "updateMessage" TEXT NOT NULL DEFAULT 'A newer app version is available.';

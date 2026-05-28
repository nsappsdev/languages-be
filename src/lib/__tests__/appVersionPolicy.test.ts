import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateAppVersionPolicy,
  PlatformVersionPolicy,
} from '../appVersionPolicy';

const policy: PlatformVersionPolicy = {
  platform: 'android',
  enabled: true,
  latestBuildNumber: 24,
  minSupportedBuildNumber: 20,
  storeUrl: 'https://play.google.com/store/apps/details?id=com.nsappsdev.language',
  message: 'A newer app version is available.',
};

describe('evaluateAppVersionPolicy', () => {
  it('requires an update below the minimum build number', () => {
    assert.deepEqual(evaluateAppVersionPolicy(policy, 19), {
      available: true,
      required: true,
    });
  });

  it('reports an optional update below the latest build number', () => {
    assert.deepEqual(evaluateAppVersionPolicy(policy, 21), {
      available: true,
      required: false,
    });
  });

  it('reports no update at the latest build number', () => {
    assert.deepEqual(evaluateAppVersionPolicy(policy, 24), {
      available: false,
      required: false,
    });
  });

  it('does not prompt when policy is disabled', () => {
    assert.deepEqual(evaluateAppVersionPolicy({ ...policy, enabled: false }, 19), {
      available: false,
      required: false,
    });
  });
});

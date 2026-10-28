import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

// Every page on this site is prerendered at build time, except /news and
// /confirm/[token], which render per request. So the prerendered pages are
// served straight from Workers static assets: no KV or R2, no cache writes,
// nothing to clean up, and it works on the free plan. The trade-off is no ISR;
// nothing uses it any more (see CLOUDFLARE-MIGRATION.md).
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
  // Serve cached pages without booting Next's request handler (less CPU per
  // request, which matters under the free plan's 10 ms CPU limit).
  enableCacheInterception: true,
});

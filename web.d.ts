// Files Server.ts imports as files (Bun gives their paths), typed for
// tsc: the app's icons, manifest and service worker
declare module "*.png" { const path: string; export default path; }
declare module "*.webmanifest" { const path: string; export default path; }
declare module "*/sw.js" { const path: string; export default path; }

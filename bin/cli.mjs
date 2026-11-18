#!/usr/bin/env node
// Legacy entry point kept for older installs; every package.json bin now points at ctxtop.mjs.
export * from './ctxtop.mjs';
import ctxtop, { isCliMain, main } from './ctxtop.mjs';
export default ctxtop;

// Run the CLI when this file is executed directly (or through a symlink), not when imported.
if (isCliMain(globalThis.process?.argv?.[1], import.meta.url)) main();

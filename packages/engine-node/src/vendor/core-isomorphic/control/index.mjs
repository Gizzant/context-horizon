/**
 * @file src/core-isomorphic/control/index.mjs
 * Execution Control Plane Unified Barrel (Milestone 4 — Features 24–28).
 * Pure ESM with strictly 0 node:* imports adhering to Claude Mod Laws 1–5.
 */

export {
  createSpan,
  endSpan,
  closeUnclosedSpans,
  buildCallTree,
  computeCriticalPath,
  renderCallTree,
  buildFlamegraphData
} from './callTree.mjs';

export {
  parseWorktreePorcelain,
  extractAgentLocation,
  applySubagentLifecycle,
  computeSwarmSummary,
  formatSwarmCompact,
  toCostRadarTopology,
  SWARM_LIFECYCLE_CONSTANTS,
  acquireScopeLock,
  evaluateScopeAndQuotaBrake,
  matchesScopePattern
} from './swarmWorktree.mjs';

export {
  CONTROL_STATES,
  createInitialControlState,
  transitionControlState,
  parseControlFile,
  serializeControlFile,
  evaluateToolBoundaryLatch
} from './controlStateMachine.mjs';

export {
  evaluateCoachLatch,
  renderCoachPill
} from './coachLatches.mjs';

export {
  SUSPENSION_CONSTANTS,
  waitForSuspensionResume,
  toProtoSafePreHookOutput,
  wrapSafeToolBoundary
} from './toolSuspension.mjs';

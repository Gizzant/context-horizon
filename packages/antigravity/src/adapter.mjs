/**
 * Google Antigravity Adapter (`src/adapters/antigravity/index.mjs`)
 *
 * Bridges Antigravity IDE / CLI lifecycle hooks (`SessionStart`, `PreInvocation`,
 * `PostInvocation`, `Stop`, `PreToolUse`, `PostToolUse`), Turn-Boundary Model Switch
 * Buffering, and `/swarm` Idle-TTL + Cold-Cache Wakeup sensors.
 */

import {
  handlePreInvocation,
  handlePreToolUse
} from '@ctxtop/engine-node/hooks/pre_invocation.mjs';
import {
  handlePostInvocation,
  handlePostToolUse
} from '@ctxtop/engine-node/hooks/post_invocation.mjs';
import {
  TurnBoundaryModelSwitchBuffer,
  trackModelCachePools,
  detectRouterThrash,
  computeQuotaAndCacheTelemetry
} from '@ctxtop/engine-node/core/quota.mjs';
import {
  SwarmIdleTtlTracker,
  evaluateSwarmColdCacheWakeup,
  computeSwarmRosterTtlBadges,
  SWARM_IDLE_TTL_CONSTANTS
} from '@ctxtop/engine-node/core/subagents.mjs';
import {
  SWARM_TOOL_MATCHER,
  FLAT_LIFECYCLE_EVENTS,
  validateAntigravityHooksSchema
} from '@ctxtop/engine-node/core/layer5_hygiene.mjs';
import { buildHooksConfig } from '@ctxtop/engine-node/cli/init.mjs';
import {
  formatAgentCacheKey,
  formatAgentStreamKey,
  parseAgentCacheKey,
  resolveModelDescriptor,
  resolveModelRates,
  calculateModelCost,
  computeUnifiedContextPool,
  evaluateCarbonVerbosityGuardrail
} from '@ctxtop/engine-node/core/constants.mjs';
import {
  readSidecarSync,
  writeSidecarAtomicSync,
  updateSwarmAgentStateAtomicSync
} from '@ctxtop/engine-node/core/sidecar_store.mjs';
import { checkIndex, buildIndex, sliceFile } from '@ctxtop/engine-node/core/doc_indexer.mjs';
import {
  evaluateShieldReadGuard,
  configureShield,
  getShieldStatus
} from '@ctxtop/engine-node/core/shield_manager.mjs';
import { runSessionAudit, formatSessionAuditReport } from '@ctxtop/engine-node/core/session_auditor.mjs';
import {
  resolveModelCliffSpec,
  evaluateParameterizedCliffBreaker
} from '@ctxtop/core/economics/cliffBreaker.mjs';
import {
  handleAntigravityRslHook,
  syncAntigravityWorkspaceRslHooks
} from '@ctxtop/engine-node/hooks/antigravity_rsl_hook.mjs';
export * from '@ctxtop/engine-node/rsl/index.mjs';
export * from '@ctxtop/engine-node/rsl/index.mjs';
export * from '@ctxtop/engine-node/rsl/index.mjs';

export {
  handleAntigravityRslHook,
  syncAntigravityWorkspaceRslHooks,
  handlePreInvocation,
  handlePreToolUse,
  handlePostInvocation,
  handlePostToolUse,
  TurnBoundaryModelSwitchBuffer,
  trackModelCachePools,
  detectRouterThrash,
  computeQuotaAndCacheTelemetry,
  SwarmIdleTtlTracker,
  evaluateSwarmColdCacheWakeup,
  computeSwarmRosterTtlBadges,
  SWARM_IDLE_TTL_CONSTANTS,
  SWARM_TOOL_MATCHER,
  FLAT_LIFECYCLE_EVENTS,
  validateAntigravityHooksSchema,
  buildHooksConfig,
  formatAgentCacheKey,
  formatAgentStreamKey,
  parseAgentCacheKey,
  resolveModelDescriptor,
  resolveModelRates,
  calculateModelCost,
  computeUnifiedContextPool,
  evaluateCarbonVerbosityGuardrail,
  readSidecarSync,
  writeSidecarAtomicSync,
  updateSwarmAgentStateAtomicSync,
  checkIndex,
  buildIndex,
  sliceFile,
  evaluateShieldReadGuard,
  configureShield,
  getShieldStatus,
  resolveModelCliffSpec,
  evaluateParameterizedCliffBreaker,
  runSessionAudit,
  formatSessionAuditReport
};

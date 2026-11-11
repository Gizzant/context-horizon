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
} from '../../hooks/pre_invocation.mjs';
import {
  handlePostInvocation,
  handlePostToolUse
} from '../../hooks/post_invocation.mjs';
import {
  TurnBoundaryModelSwitchBuffer,
  trackModelCachePools,
  detectRouterThrash,
  computeQuotaAndCacheTelemetry
} from '../../core/quota.mjs';
import {
  SwarmIdleTtlTracker,
  evaluateSwarmColdCacheWakeup,
  computeSwarmRosterTtlBadges,
  SWARM_IDLE_TTL_CONSTANTS
} from '../../core/subagents.mjs';
import {
  SWARM_TOOL_MATCHER,
  FLAT_LIFECYCLE_EVENTS,
  validateAntigravityHooksSchema
} from '../../core/layer5_hygiene.mjs';
import { buildHooksConfig } from '../../cli/init.mjs';
import {
  formatAgentCacheKey,
  formatAgentStreamKey,
  parseAgentCacheKey,
  resolveModelDescriptor,
  resolveModelRates,
  calculateModelCost,
  computeUnifiedContextPool,
  evaluateCarbonVerbosityGuardrail
} from '../../core/constants.mjs';
import {
  readSidecarSync,
  writeSidecarAtomicSync,
  updateSwarmAgentStateAtomicSync
} from '../../core/sidecar_store.mjs';

export {
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
  updateSwarmAgentStateAtomicSync
};

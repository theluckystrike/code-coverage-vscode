'use strict';
// Free tries for Pro tools, keyed by tool id in globalState. A try counts only after the tool produced its result.
// globalState can return an older value for a moment after a write, so the in-memory `seen` map keeps counts
// monotonic within a session.
function createTrialAccess(state, key, limit = 3, onUse = () => {}) {
  const seen = {};
  const read = feature => Math.max(Number(state.get(key, {})[feature] || 0), seen[feature] || 0);
  return {
    used: read,
    remaining: feature => Math.max(0, limit - read(feature)),
    allow: feature => {
      if (read(feature) >= limit) return false;
      let complete = false;
      return { async done() {
        if (complete) return false;
        const used = read(feature);
        if (used >= limit) return false;
        const values = { ...state.get(key, {}), [feature]: used + 1 };
        seen[feature] = used + 1;
        await state.update(key, values);
        complete = true;
        await onUse(feature, used + 1, Math.max(0, limit - used - 1));
        return true;
      } };
    }
  };
}
module.exports = { createTrialAccess };

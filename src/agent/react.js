/** Compatibility entry point: AI has no runtime tool access. */
export async function agentLoop(goal) {
  return {
    content: "Trading uses deterministic rules. Use /screen, /positions, /close, /balance or /rules update. AI is restricted to validated rule updates.",
    userMessage: goal,
    blocked: true,
  };
}

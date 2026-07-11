export interface AgentContact {
  id: string;
  name: string;
  tagline: string;
  avatar: string;
}

/**
 * The AI agents you can call. `id` must match an agent the `server/` backend
 * runs and mints tokens for (the bundled backend runs `assistant`).
 */
export const AGENTS: AgentContact[] = [
  { id: 'assistant', name: 'Assistant', tagline: 'AI voice agent', avatar: '🤖' },
];

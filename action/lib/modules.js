/** Module specifiers that mark a file as agent code, or as already importing the guard. */
export function pythonSpecifiers(text) {
    const out = [];
    for (const m of text.matchAll(/^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\b/gm)) {
        if (m[1] !== undefined)
            out.push({ spec: m[1], runtime: true });
    }
    for (const m of text.matchAll(/^\s*import\s+([^\n]+)/gm)) {
        const body = m[1] ?? '';
        for (const part of body.split(',')) {
            const name = part.trim().split(/\s+/)[0];
            if (name !== undefined && name !== '')
                out.push({ spec: name, runtime: true });
        }
    }
    return out;
}
export function phpSpecifiers(text) {
    const out = [];
    for (const m of text.matchAll(/\buse\s+([^;]+);/g)) {
        const body = m[1] ?? '';
        for (const part of body.split(',')) {
            const name = part.replace(/\s+as\s+.+$/i, '').trim();
            if (name !== '')
                out.push({ spec: name, runtime: true });
        }
    }
    return out;
}
export function isAgentSpecifier(spec) {
    const s = spec.trim();
    if (s === 'ai' || s.startsWith('ai/'))
        return true;
    if (s === '@openai/agents' || s.startsWith('@openai/agents/'))
        return true;
    if (s === 'openai-agents' || s.startsWith('openai.agents') || s.startsWith('openai_agents'))
        return true;
    if (s === 'langchain' || s.startsWith('langchain.') || s.startsWith('langchain/') || s.startsWith('@langchain/'))
        return true;
    if (s.includes('@modelcontextprotocol'))
        return true;
    if (s === 'mastra' || s.startsWith('mastra/') || s.startsWith('@mastra/'))
        return true;
    if (s === 'crewai' || s.startsWith('crewai.') || s.startsWith('crewai/'))
        return true;
    if (/(^|[\\/])(langchain|langchaingo|mastra|crewai|modelcontextprotocol)([\\/]|$)/i.test(s))
        return true;
    if (/(^|[\\/])OpenAI[\\/]Agents([\\/]|$)/.test(s))
        return true;
    if (/(^|[\\/])Mastra([\\/]|$)/.test(s))
        return true;
    if (/(^|[\\/])CrewAI([\\/]|$)/.test(s))
        return true;
    if (/(^|[\\/])LangChain([\\/]|$)/.test(s))
        return true;
    return false;
}
export function isGuardSpecifier(spec) {
    const s = spec.trim();
    if (s === 'agent-email-guard' || s.startsWith('agent-email-guard/'))
        return true;
    if (s === 'agent_email_guard' || s.startsWith('agent_email_guard.') || s.startsWith('agent_email_guard/'))
        return true;
    if (s.includes('github.com/agentisend/agent-email-guard'))
        return true;
    if (s.includes('AgentiSend\\AgentEmailGuard') || s.includes('AgentiSend/AgentEmailGuard'))
        return true;
    return false;
}

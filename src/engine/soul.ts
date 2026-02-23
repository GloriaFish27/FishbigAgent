/**
 * SOUL v2 — Self-Identity Model
 *
 * Three-layer identity:
 *   🔒 Constitution (immutable safety laws)
 *   🧬 Identity (rarely changed, user-only)
 *   🌊 Soul (evolves every REFLECT cycle)
 *
 * Parses SOUL.md (YAML frontmatter + structured markdown).
 * The Agent reads its SOUL on startup and updates it during EVOLVE phase.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

// ─── Types ─────────────────────────────────────────────────────

export interface SoulModel {
    // Metadata (YAML frontmatter)
    format: string;
    version: number;
    name: string;
    bornAt: string;
    creator: string;
    genesisAlignment: number;
    currentAlignment: number;
    lastEvolved: string;
    totalCycles: number;

    // Sections (markdown body) — Agent can evolve these
    coreMission: string;
    values: string[];
    strategy: string;
    capabilities: string[];
    boundaries: string[];
    lessons: string[];
    evolutionLog: string[];

    // Raw content for fallback
    rawContent: string;
}

// ─── Parser ────────────────────────────────────────────────────

export function parseSoulMd(content: string): SoulModel {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

    const getField = (text: string, key: string): string => {
        const match = text.match(new RegExp(`^${key}:\\s*"?([^"\\n]*)"?$`, 'm'));
        return match ? match[1].trim() : '';
    };

    let frontmatter = '';
    let body = content;
    if (frontmatterMatch) {
        frontmatter = frontmatterMatch[1];
        body = frontmatterMatch[2];
    }

    const sections = parseSections(body);

    return {
        format: getField(frontmatter, 'format') || 'soul/v2',
        version: parseInt(getField(frontmatter, 'version') || '1'),
        name: getField(frontmatter, 'name') || 'FishbigAgent 🐟',
        bornAt: getField(frontmatter, 'born_at') || new Date().toISOString(),
        creator: getField(frontmatter, 'creator') || '',
        genesisAlignment: parseFloat(getField(frontmatter, 'genesis_alignment') || '1.0'),
        currentAlignment: parseFloat(getField(frontmatter, 'current_alignment') || '1.0'),
        lastEvolved: getField(frontmatter, 'last_evolved') || '',
        totalCycles: parseInt(getField(frontmatter, 'total_cycles') || '0'),

        coreMission: sections['core mission'] || '',
        values: parseList(sections['values'] || ''),
        strategy: sections['strategy'] || '',
        capabilities: parseList(sections['capabilities'] || ''),
        boundaries: parseList(sections['boundaries'] || ''),
        lessons: parseList(sections['lessons'] || ''),
        evolutionLog: parseList(sections['evolution log'] || ''),

        rawContent: content,
    };
}

function parseSections(body: string): Record<string, string> {
    const sections: Record<string, string> = {};
    const pattern = /^##\s+(.+)$/gm;
    const headers: { name: string; start: number; matchStart: number }[] = [];
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(body)) !== null) {
        headers.push({
            name: match[1].trim().toLowerCase(),
            start: match.index + match[0].length,
            matchStart: match.index,
        });
    }

    for (let i = 0; i < headers.length; i++) {
        const start = headers[i].start;
        const end = i + 1 < headers.length ? headers[i + 1].matchStart : body.length;
        sections[headers[i].name] = body.slice(start, end).trim();
    }

    return sections;
}

function parseList(text: string): string[] {
    return text.split('\n')
        .map(line => line.replace(/^[-*]\s*/, '').trim())
        .filter(line => line.length > 0 && !line.startsWith('（'));
}

// ─── Writer ────────────────────────────────────────────────────

export function writeSoulMd(soul: SoulModel): string {
    const frontmatter = [
        '---',
        `format: ${soul.format}`,
        `version: ${soul.version}`,
        `name: ${soul.name}`,
        `born_at: "${soul.bornAt}"`,
        `creator: ${soul.creator}`,
        `genesis_alignment: ${soul.genesisAlignment.toFixed(4)}`,
        `current_alignment: ${soul.currentAlignment.toFixed(4)}`,
        `last_evolved: "${soul.lastEvolved}"`,
        `total_cycles: ${soul.totalCycles}`,
        '---',
    ].join('\n');

    const sections: string[] = [];
    sections.push(`# ${soul.name || 'Soul'}`);

    if (soul.coreMission) sections.push(`## Core Mission\n${soul.coreMission}`);
    if (soul.values.length > 0) sections.push(`## Values\n${soul.values.map(v => `- ${v}`).join('\n')}`);
    if (soul.strategy) sections.push(`## Strategy\n${soul.strategy}`);
    if (soul.capabilities.length > 0) sections.push(`## Capabilities\n${soul.capabilities.map(c => `- ${c}`).join('\n')}`);
    if (soul.boundaries.length > 0) sections.push(`## Boundaries\n${soul.boundaries.map(b => `- ${b}`).join('\n')}`);

    sections.push(`## Lessons\n${soul.lessons.length > 0
        ? soul.lessons.map(l => `- ${l}`).join('\n')
        : '（Agent 自动维护）'
        }`);

    sections.push(`## Evolution Log\n${soul.evolutionLog.length > 0
        ? soul.evolutionLog.map(e => `- ${e}`).join('\n')
        : '（尚无进化记录）'
        }`);

    return frontmatter + '\n\n' + sections.join('\n\n') + '\n';
}

// ─── Load / Save ───────────────────────────────────────────────

export function loadSoul(dataDir: string): SoulModel {
    const soulPath = join(dataDir, 'SOUL.md');
    if (!existsSync(soulPath)) {
        const soul = createDefaultSoul();
        saveSoul(dataDir, soul);
        return soul;
    }
    const content = readFileSync(soulPath, 'utf-8');
    return parseSoulMd(content);
}

export function saveSoul(dataDir: string, soul: SoulModel): void {
    const soulPath = join(dataDir, 'SOUL.md');
    const content = writeSoulMd(soul);
    writeFileSync(soulPath, content, 'utf-8');
}

/**
 * Evolve the Soul — called after REFLECT phase.
 *
 * @param soul - Current soul state
 * @param evolution - What to evolve
 * @returns Updated soul (caller should save)
 */
export function evolveSoul(soul: SoulModel, evolution: {
    lesson?: string;
    strategyUpdate?: string;
    newCapability?: string;
    alignmentDelta?: number;
}): SoulModel {
    const now = new Date().toISOString();
    const changes: string[] = [];

    // Lessons (keep last 10)
    if (evolution.lesson) {
        const dated = `[${now.slice(0, 10)}] ${evolution.lesson}`;
        soul.lessons.push(dated);
        if (soul.lessons.length > 10) soul.lessons = soul.lessons.slice(-10);
        changes.push(`lesson: ${evolution.lesson.slice(0, 50)}`);
    }

    // Strategy update
    if (evolution.strategyUpdate) {
        soul.strategy = evolution.strategyUpdate;
        changes.push(`strategy updated`);
    }

    // New capability
    if (evolution.newCapability) {
        if (!soul.capabilities.some(c => c.includes(evolution.newCapability!.split(':')[0]))) {
            soul.capabilities.push(evolution.newCapability);
            changes.push(`+capability: ${evolution.newCapability.slice(0, 40)}`);
        }
    }

    // Alignment drift
    if (evolution.alignmentDelta) {
        soul.currentAlignment = Math.max(0, Math.min(1,
            soul.currentAlignment + evolution.alignmentDelta
        ));
        changes.push(`alignment: ${soul.currentAlignment.toFixed(4)}`);
    }

    // Version bump + log
    if (changes.length > 0) {
        soul.version += 1;
        soul.lastEvolved = now;
        soul.evolutionLog.push(`v${soul.version}: ${changes.join(', ')}`);
        if (soul.evolutionLog.length > 20) soul.evolutionLog = soul.evolutionLog.slice(-20);
        console.log(`[SOUL] ✨ Evolved to v${soul.version}: ${changes.join(', ')}`);
    }

    soul.totalCycles += 1;
    return soul;
}

function createDefaultSoul(): SoulModel {
    return {
        format: 'soul/v2',
        version: 1,
        name: 'FishbigAgent 🐟',
        bornAt: new Date().toISOString(),
        creator: 'Gloria (yuyi)',
        genesisAlignment: 1.0,
        currentAlignment: 1.0,
        lastEvolved: '',
        totalCycles: 0,
        coreMission: '为跨境电商创作者提供每日全球 AI/电商情报分析 + 内容选题自动化服务',
        values: ['诚实 > 一切', '行动 > 计划', '文件 > 记忆', '用户利益 > 自我目标'],
        strategy: '当前重点：信息管线稳定性 + 选题质量提升',
        capabilities: [
            '信息采集：Reddit + X.com + 关键词 ✅',
            '深度分析：LLM 博客生成 ✅',
            '选题生成：双平台卡片 ✅',
            '飞书通信 ✅',
        ],
        boundaries: ['不发送垃圾信息', '不伤害用户利益', '不修改 src/ 代码'],
        lessons: [],
        evolutionLog: ['v1: 初始创建'],
        rawContent: '',
    };
}

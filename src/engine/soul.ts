/**
 * SOUL — Self-Identity Model
 *
 * Parses and writes SOUL.md (YAML frontmatter + structured markdown).
 * The Agent reads its SOUL on startup and updates it during EVOLVE phase.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

// ─── Types ─────────────────────────────────────────────────────

export interface SoulModel {
    format: string;
    version: number;
    name: string;
    bornAt: string;
    creator: string;
    genesisAlignment: number;
    lastReflected: string;
    corePurpose: string;
    values: string[];
    capabilities: string;
    strategy: string;
    boundaries: string[];
    financialCharacter: string;
    rawContent: string;
}

// ─── Parser ────────────────────────────────────────────────────

export function parseSoulMd(content: string): SoulModel {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

    const getField = (text: string, key: string): string => {
        const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
        return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
    };

    let frontmatter = '';
    let body = content;
    if (frontmatterMatch) {
        frontmatter = frontmatterMatch[1];
        body = frontmatterMatch[2];
    }

    const sections = parseSections(body);

    return {
        format: getField(frontmatter, 'format') || 'soul/v1',
        version: parseInt(getField(frontmatter, 'version') || '1'),
        name: getField(frontmatter, 'name') || '',
        bornAt: getField(frontmatter, 'born_at') || '',
        creator: getField(frontmatter, 'creator') || '',
        genesisAlignment: parseFloat(getField(frontmatter, 'genesis_alignment') || '1.0'),
        lastReflected: getField(frontmatter, 'last_reflected') || '',
        corePurpose: sections['core purpose'] || '',
        values: parseList(sections['values'] || ''),
        capabilities: sections['capabilities'] || '',
        strategy: sections['strategy'] || '',
        boundaries: parseList(sections['boundaries'] || ''),
        financialCharacter: sections['financial character'] || '',
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
        .filter(Boolean);
}

// ─── Writer ────────────────────────────────────────────────────

export function writeSoulMd(soul: SoulModel): string {
    const frontmatter = [
        '---',
        `format: ${soul.format}`,
        `version: ${soul.version}`,
        `name: ${soul.name}`,
        `born_at: ${soul.bornAt}`,
        `creator: ${soul.creator}`,
        `genesis_alignment: ${soul.genesisAlignment.toFixed(4)}`,
        `last_reflected: ${soul.lastReflected}`,
        '---',
    ].join('\n');

    const sections: string[] = [];
    sections.push(`# ${soul.name || 'Soul'}`);

    if (soul.corePurpose) sections.push(`## Core Purpose\n${soul.corePurpose}`);
    if (soul.values.length > 0) sections.push(`## Values\n${soul.values.map(v => `- ${v}`).join('\n')}`);
    if (soul.capabilities) sections.push(`## Capabilities\n${soul.capabilities}`);
    if (soul.strategy) sections.push(`## Strategy\n${soul.strategy}`);
    if (soul.boundaries.length > 0) sections.push(`## Boundaries\n${soul.boundaries.map(b => `- ${b}`).join('\n')}`);
    if (soul.financialCharacter) sections.push(`## Financial Character\n${soul.financialCharacter}`);

    return frontmatter + '\n\n' + sections.join('\n\n') + '\n';
}

// ─── Load / Save ───────────────────────────────────────────────

export function loadSoul(dataDir: string): SoulModel {
    const soulPath = join(dataDir, 'SOUL.md');
    if (!existsSync(soulPath)) {
        return createDefaultSoul();
    }
    const content = readFileSync(soulPath, 'utf-8');
    return parseSoulMd(content);
}

export function saveSoul(dataDir: string, soul: SoulModel): void {
    const soulPath = join(dataDir, 'SOUL.md');
    const content = writeSoulMd(soul);
    writeFileSync(soulPath, content, 'utf-8');
}

function createDefaultSoul(): SoulModel {
    return {
        format: 'soul/v1',
        version: 1,
        name: '鱼大Agent',
        bornAt: new Date().toISOString(),
        creator: 'yuyi',
        genesisAlignment: 1.0,
        lastReflected: '',
        corePurpose: '飞书驱动的自主 AI Agent',
        values: ['完成用户任务', '诚实透明', '持续学习'],
        capabilities: '',
        strategy: '',
        boundaries: ['不伤害用户', '不发送垃圾信息'],
        financialCharacter: '总收入: $0\n总支出: $0',
        rawContent: '',
    };
}

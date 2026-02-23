/**
 * SkillLoader - Scans skills directories for SKILL.md files
 * and injects their instructions into the system prompt.
 */
import fs from 'fs';
import path from 'path';

export interface Skill {
    name: string;
    description: string;
    instructions: string;
    dir: string;
}

export class SkillLoader {
    private skillsDir: string;

    constructor(projectRoot: string) {
        this.skillsDir = path.join(projectRoot, 'skills');
    }

    /** Load all skills from skills directory */
    loadAll(): Skill[] {
        if (!fs.existsSync(this.skillsDir)) return [];

        const skills: Skill[] = [];
        const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const skillFile = path.join(this.skillsDir, entry.name, 'SKILL.md');
            if (!fs.existsSync(skillFile)) continue;

            try {
                const content = fs.readFileSync(skillFile, 'utf-8');
                const skill = this._parse(content, entry.name, path.join(this.skillsDir, entry.name));
                if (skill) skills.push(skill);
            } catch (err) {
                console.error(`[SKILLS] Failed to load ${entry.name}:`, err);
            }
        }

        if (skills.length > 0) {
            console.log(`[SKILLS] Loaded ${skills.length} skill(s): ${skills.map(s => s.name).join(', ')}`);
        }
        return skills;
    }

    /** Parse SKILL.md with YAML frontmatter */
    private _parse(content: string, dirName: string, dir: string): Skill | null {
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
        if (!fmMatch) {
            return {
                name: dirName,
                description: '',
                instructions: content.trim(),
                dir,
            };
        }

        const frontmatter = fmMatch[1];
        const body = fmMatch[2].trim();

        const meta: Record<string, string> = {};
        for (const line of frontmatter.split('\n')) {
            const m = line.match(/^(\w[\w-]*):\s*(.+)$/);
            if (m) meta[m[1]] = m[2].trim();
        }

        return {
            name: meta.name ?? dirName,
            description: meta.description ?? '',
            instructions: body.replace(/\{baseDir\}/g, dir),
            dir,
        };
    }

    /** Build prompt section for all loaded skills */
    static buildPrompt(skills: Skill[]): string {
        if (skills.length === 0) return '';

        const parts = ['## 可用 Skills\n'];
        for (const skill of skills) {
            parts.push(`### /${skill.name}`);
            if (skill.description) parts.push(skill.description);
            parts.push('');
            parts.push(skill.instructions.slice(0, 1500));
            parts.push('');
        }
        return parts.join('\n');
    }
}

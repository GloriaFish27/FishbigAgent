/**
 * Notion Database Setup Script
 * Run: NOTION_TOKEN=ntn_xxx NOTION_PAGE_ID=xxx node scripts/setup-notion.mjs
 */

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PARENT_PAGE = process.env.NOTION_PAGE_ID;

if (!NOTION_TOKEN || !PARENT_PAGE) {
    console.error('用法: NOTION_TOKEN=ntn_xxx NOTION_PAGE_ID=xxx node scripts/setup-notion.mjs');
    process.exit(1);
}

const HEADERS = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
};

async function createDb(title, emoji, properties) {
    const res = await fetch('https://api.notion.com/v1/databases', {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
            parent: { type: 'page_id', page_id: PARENT_PAGE },
            title: [{ text: { content: `${emoji} ${title}` } }],
            properties,
        }),
    });
    const data = await res.json();
    if (data.id) {
        console.log(`✅ ${title}: ${data.id}`);

        // Rename default "Name" to our title property
        const updateRes = await fetch(`https://api.notion.com/v1/databases/${data.id}`, {
            method: 'PATCH',
            headers: HEADERS,
            body: JSON.stringify({
                properties: Object.fromEntries(
                    Object.entries(properties).map(([k, v]) => {
                        if (v.title) return ['Name', { name: k }];
                        return [k, v];
                    })
                ),
            }),
        });
        const updated = await updateRes.json();
        if (updated.properties) {
            console.log(`   Props: ${Object.keys(updated.properties).join(', ')}`);
        }
        return data.id;
    } else {
        console.error(`❌ ${title}: ${data.message}`);
        return null;
    }
}

async function main() {
    console.log('🐟 正在创建 Notion 数据库...\n');

    // 1. 每日简报
    const briefingId = await createDb('每日简报', '📊', {
        '标题': { title: {} },
        '日期': { date: {} },
        '主题数': { number: {} },
        '飞书链接': { url: {} },
        '状态': {
            select: {
                options: [
                    { name: '已生成', color: 'green' },
                    { name: '已阅读', color: 'gray' },
                ]
            }
        },
    });

    // 2. 选题库
    const topicId = await createDb('选题库', '📝', {
        '选题': { title: {} },
        '公众号标题': { rich_text: {} },
        '支柱': {
            select: {
                options: [
                    { name: 'AI×跨境实战', color: 'red' },
                    { name: '赚钱方法论', color: 'yellow' },
                    { name: 'AI Coding教学', color: 'blue' },
                    { name: '趋势解读', color: 'purple' },
                    { name: '个人成长', color: 'pink' },
                ]
            }
        },
        '平台': {
            multi_select: {
                options: [
                    { name: '小红书', color: 'red' },
                    { name: '公众号', color: 'green' },
                ]
            }
        },
        '优先级': { number: {} },
        '状态': {
            select: {
                options: [
                    { name: '待选', color: 'default' },
                    { name: '已选', color: 'blue' },
                    { name: '创作中', color: 'yellow' },
                    { name: '已发布', color: 'green' },
                    { name: '搁置', color: 'gray' },
                ]
            }
        },
        '日期': { date: {} },
        '钩子': { rich_text: {} },
        '鱼大角度': { rich_text: {} },
        '素材来源': { rich_text: {} },
        '卡片图大纲': { rich_text: {} },
        '文章结构': { rich_text: {} },
    });

    // 3. 素材库
    const materialId = await createDb('素材库', '📦', {
        '标题': { title: {} },
        '来源': {
            select: {
                options: [
                    { name: 'Reddit', color: 'orange' },
                    { name: 'X.com', color: 'blue' },
                ]
            }
        },
        'URL': { url: {} },
        '摘要': { rich_text: {} },
        '热度': { number: {} },
        '日期': { date: {} },
        '已用': { checkbox: {} },
    });

    // 4. Add relation: 选题 → 素材
    if (topicId && materialId) {
        const relRes = await fetch(`https://api.notion.com/v1/databases/${topicId}`, {
            method: 'PATCH',
            headers: HEADERS,
            body: JSON.stringify({
                properties: {
                    '关联素材': {
                        relation: {
                            database_id: materialId,
                            type: 'dual_property',
                            dual_property: { synced_property_name: '关联选题' },
                        },
                    },
                },
            }),
        });
        const relData = await relRes.json();
        if (relData.properties) console.log('\n✅ 关联素材 Relation 已创建');
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📋 把以下 ID 填入 config/config.json:');
    console.log(`"briefingDbId": "${briefingId}",`);
    console.log(`"topicDbId": "${topicId}",`);
    console.log(`"materialDbId": "${materialId}"`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch(console.error);

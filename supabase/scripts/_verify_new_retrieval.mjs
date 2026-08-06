#!/usr/bin/env node
// 验证新检索链路（语义词×2 + 原句×1.5）在话术库的召回效果
const STOP = new Set('的了吗呢啊呀吧怎么什么为要了是在和与就都也很也想可以应该着过把被让对给跟别还正在向从'.split(''));
const gramsOf = (text) => {
  const clean = text.replace(/[^\u4e00-\u9fa5]/g, '');
  const set = new Set();
  for (let i = 0; i + 2 <= clean.length; i++) {
    const bg = clean.slice(i, i + 2);
    if (bg.split('').every(c => STOP.has(c))) continue;
    set.add(bg);
    if (set.size >= 200) return;
  }
  return set;
};

(async () => {
  const PAT = process.env.SBP_PAT;
  const REF = 'opzvvgixlfbfpdlsorbi';
  const kr = await fetch(`https://api.supabase.com/v1/projects/${REF}/api-keys`, {
    headers: { Authorization: `Bearer ${PAT}` },
  });
  const keys = await kr.json();
  const sr = keys.find(k => k.name === 'service_role' || k.role === 'service_role');
  const JWT = sr.api_key || sr.key;

  const cases = [
    { q: '她说今天被领导骂了很难受', semantic: ['委屈', '安慰', '哄', '难过', '关心'] },
    { q: '她两天没回我消息了，是不是不喜欢我了', semantic: ['冷淡', '高冷', '忽冷忽热', '追问', '试探'] },
    { q: '她生气了不理我，我该怎么哄', semantic: ['生气', '哄', '道歉', '解释', '冷战'] },
    { q: '她突然对我忽冷忽热的，怎么办', semantic: ['忽冷忽热', '冷淡', '高冷', '推拉', '试探'] },
    { q: '我想约她出来见面', semantic: ['邀约', '约会', '见面', '开场白', '搭讪'] },
  ];
  for (const c of cases) {
    const queries = [...c.semantic, c.q];
    const grams = new Set();
    for (const q of queries) for (const g of gramsOf(q)) grams.add(g);
    const semSet = new Set(c.semantic);
    const weights = queries.map(q => (semSet.has(q) ? 2 : 1.5));
    const r = await fetch(`https://${REF}.supabase.co/rest/v1/rpc/kb_blocks_recall`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${JWT}`, apikey: JWT, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_grams: [...grams].slice(0, 80), p_words: queries.slice(0, 20),
        p_weights: weights.slice(0, 20), p_limit: 24, p_max_blocks_per_doc: 2,
      }),
    });
    const rows = await r.json();
    const folders = {};
    (Array.isArray(rows) ? rows : []).forEach(x => { folders[x.folder_id] = (folders[x.folder_id] || 0) + 1; });
    console.log(`「${c.q}」 → 召回 ${Array.isArray(rows) ? rows.length : 0} 块, folder: ${JSON.stringify(folders)}`);
    if (Array.isArray(rows) && rows.length) {
      rows.slice(0, 2).forEach(x => console.log(`   [${(x.title || '').slice(0, 22)}] ${x.content.slice(0, 35).replace(/\n/g, ' ')}...`));
    }
  }
})();

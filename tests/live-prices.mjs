#!/usr/bin/env node
/* 가격표 시험 — index.html 의 진짜 함수(가격 그리기 · 앱 가격표 읽기)를 꺼내 돌려 본다.
   실행: node tests/live-prices.mjs
   앱(서적부 POS)이 Firestore public/catalog 에 번호별 정가·할인율을 써 두고, 카탈로그가 그걸 읽어
   books.csv 값을 덮어쓴다. 못 읽으면 CSV 값 그대로여야 한다. */
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const src = scripts[scripts.length - 1];

// 이름으로 최상위 선언 하나를 통째로 잘라 온다 (서적부 POS 저장소 tests/grab-index.mjs 와 같은 방식)
function grab(name) {
  const m = new RegExp(`^(?:const|let|function)\\s+${name.replace('$', '\\$')}\\b`, 'm').exec(src);
  if (!m) throw new Error(`index.html 에서 ${name} 을(를) 못 찾았습니다 — 이름이 바뀌었으면 이 시험도 고치세요`);
  let i = m.index, depth = 0, seenBody = false;
  const isFn = m[0].startsWith('function');
  const stack = [];
  for (; i < src.length; i++) {
    const c = src[i], top = stack[stack.length - 1];
    if (top === '"' || top === "'") { if (c === '\\') i++; else if (c === top) stack.pop(); continue; }
    if (top === '`') { if (c === '\\') i++; else if (c === '`') stack.pop(); else if (c === '$' && src[i + 1] === '{') { stack.push('${'); i++; depth++; } continue; }
    if (top === '/') { if (c === '\\') i++; else if (c === '/') stack.pop(); continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { stack.push(c); continue; }
    if (c === '/' && /[=(,:!&|?{;]\s*$/.test(src.slice(Math.max(0, i - 20), i))) { stack.push('/'); continue; }
    // 함수는 인자 괄호 밖(깊이 0)에서 여는 { 가 본문이다 — function f({ a, b }) 의 { 와 헷갈리지 않게
    if (c === '{' || c === '(' || c === '[') { if (c === '{' && depth === 0) seenBody = true; depth++; continue; }
    if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (top === '${' && c === '}') { stack.pop(); continue; }
      if (isFn && seenBody && depth === 0 && c === '}') return src.slice(m.index, i + 1);
      continue;
    }
    if (!isFn && depth === 0 && c === ';') return src.slice(m.index, i + 1);
  }
  throw new Error(`${name} 의 끝을 못 찾았습니다`);
}

const NAMES = ['DATA', 'won', 'krw', 'pctOf', 'offPrice', 'sale', 'pr', 'readLive', 'applyLive'];
const ctx = vm.createContext({ console });
vm.runInContext(NAMES.map(grab).join('\n') + '\n;globalThis.__api = { DATA, won, sale, pr, readLive, applyLive };', ctx);
const { DATA, pr, readLive, applyLive } = ctx.__api;

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? '통과' : '실패'}  ${name}${ok ? '' : `\n      받은 값: ${JSON.stringify(got)}\n      바란 값: ${JSON.stringify(want)}`}`);
};
const has = (name, s, part, not = false) => {
  const ok = not ? !s.includes(part) : s.includes(part);
  if (!ok) fails++;
  console.log(`${ok ? '통과' : '실패'}  ${name}${ok ? '' : `\n      ${JSON.stringify(s)} 에 ${JSON.stringify(part)} 이(가) ${not ? '있음' : '없음'}`}`);
};

const intV = v => ({ integerValue: String(v) });
const restDoc = items => ({ name: 'projects/x/databases/(default)/documents/public/catalog', fields: { items: { mapValue: { fields:
  Object.fromEntries(Object.entries(items).map(([no, v]) => [no, { mapValue: { fields: { price: intV(v.price), salePct: intV(v.salePct) } } }])) } } } });

eq('readLive: REST 문서를 번호별로 편다', readLive(restDoc({ 12: { price: 155000, salePct: 50 } })), { 12: { price: 155000, salePct: 50 } });
eq('readLive: 규칙을 아직 안 올려 403 이면 null', readLive({ error: { code: 403, status: 'PERMISSION_DENIED' } }), null);
eq('readLive: 빈 응답이면 null', readLive(null), null);
const dbl = (price, pct) => ({ fields: { items: { mapValue: { fields: { 5: { mapValue: { fields: { price: { integerValue: String(price) }, salePct: { doubleValue: pct } } } } } } } } });
eq('readLive: 할인율 150 → 100 으로 자름 (앱 promoPct 와 같게)', readLive(dbl(1000, 150)), { 5: { price: 1000, salePct: 100 } });
eq('readLive: 할인율 12.5 → 13 (반올림)', readLive(dbl(1000, 12.5)), { 5: { price: 1000, salePct: 13 } });
eq('readLive: 할인율 -5 → 0', readLive(dbl(1000, -5)), { 5: { price: 1000, salePct: 0 } });
eq('readLive: 음수 정가는 버림', readLive(dbl(-1, 0)), {});
eq('readLive: 빈 가격표면 빈 객체', readLive({ fields: { items: { mapValue: {} } } }), {});

const find = no => DATA.sections.flatMap(s => s.items).filter(i => i.no === no);
applyLive({ 12: { price: 150000, salePct: 30 }, 999: { price: 1, salePct: 0 } });
eq('applyLive: 12번 정가가 앱 값', find(12).map(i => i.price), [150000]);
eq('applyLive: 12번 할인율이 앱 값', find(12).map(i => i.pct), [30]);
eq('applyLive: CSV 에 없는 999번은 생기지 않는다', find(999).length, 0);

has('pr: 30% 할인 → 할인가', pr({ price: 100000, pct: 30 }), '70,000원');
has('pr: 30% 할인 → 정가에 줄', pr({ price: 100000, pct: 30 }), '<s class="was">100,000원</s>');
has('pr: 100% 할인 → 0원', pr({ price: 5000, pct: 100 }), '0원');
has('pr: 100% 할인 → 가격 문의 아님', pr({ price: 5000, pct: 100 }), '가격 문의', true);
eq('pr: 정가 0 → 가격 문의', pr({ price: 0, pct: 0 }), '가격 문의');
has('pr: 할인도서 + 앱 할인 → 최종가', pr({ price: 20000, pct: 10, dc: true }), '할인가 : 18,000원');
has('pr: CSV 반값할인(sale) 은 50%', pr({ price: 40000, sale: true }), '20,000원');

console.log(fails ? `\n${fails}개 실패` : '\n모두 통과');
process.exit(fails ? 1 : 0);

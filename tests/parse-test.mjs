// 재료 finder tests: every recipe-writing pattern seen so far, in sample texts written for these tests.
// Run after any change to parseIngredients in index.html:
//   node tests/parse-test.mjs
// Each case notes the real link that first showed the pattern.
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('  const AMOUNT_WORDS');
const end = html.indexOf('  window.parseIngredients = parseIngredients;');
if (start < 0 || end < 0) throw new Error('parseIngredients block not found in index.html');
const parseIngredients = new Function(`${html.slice(start, end)}\nreturn parseIngredients;`)();

const show = (list) => list.map((x) => (x.amount ? `${x.name}[${x.amount}]` : x.name)).join(', ');

const cases = [
  {
    name: 'heading with emoji and serving size, [양념] comma line, stops at 만드는 법 and hashtags',
    text: `오늘은 김치찌개를 끓여볼게요.\n\n📌재료 (2인분)\n신김치 1/4포기\n돼지고기 앞다리살 200g\n두부 1/2모\n\n[양념]\n고춧가루 1큰술, 다진마늘 1큰술, 국간장 약간\n\n만드는 법\n1. 냄비에 돼지고기를 볶아주세요.\n\n#김치찌개`,
    want: '신김치[1/4포기], 돼지고기 앞다리살[200g], 두부[1/2모], 고춧가루[1큰술], 다진마늘[1큰술], 국간장[약간]',
  },
  {
    name: 'reel caption: "재료:" with everything on one line',
    text: '자취 요리 🍳 계란볶음밥!\n재료: 밥 1공기, 계란 2개, 대파 1/2대, 굴소스 1큰술, 참기름 약간\n✔️ 대파를 기름에 볶아 파기름을 내주세요\n#볶음밥',
    want: '밥[1공기], 계란[2개], 대파[1/2대], 굴소스[1큰술], 참기름[약간]',
  },
  {
    name: 'Notion bullets; 물 left out; stops at 조리 순서',
    text: '된장찌개\n재료\n- 된장 2큰술\n- 애호박 1/3개\n- 감자 1개\n- 두부 1모\n- 물 500ml\n조리 순서\n- 육수를 끓인다',
    want: '된장[2큰술], 애호박[1/3개], 감자[1개], 두부[1모]',
  },
  {
    name: 'no 재료 heading: lines that read like "이름 양"',
    text: '감자 2개\n당근 1/2개\n양파 1개\n카레가루 100g\n고기를 볶다가 채소를 넣고 끓인다.',
    want: '감자[2개], 당근[1/2개], 양파[1개], 카레가루[100g]',
  },
  {
    name: 'YouTube "재료 : a , b" without amounts; bare 레시피 heading; English copy skipped (youtu.be/iZyofxQlJ2k)',
    text: '고기 김치찌개\n\n재료 : 돼지고기 , 물 500ml , 김치 , 간장 , Msg 1/5 , 대파\n\n레시피\n\n1. 돼지고기와 물을 넣고 끓여주세요\n\nIngredients: pork, water 500ml, kimchi, soy sauce',
    want: '돼지고기, 김치, 간장, Msg[1/5], 대파',
  },
  {
    name: 'recipe site: "재료:" bullets with T, 티스푼 and 간맞추기 (10000recipe.com)',
    text: '재료:\n- 양파 1/2개\n- 된장 2T\n- 설탕 0.5티스푼\n- 물 1.5종이컵\n- 소금 간맞추기',
    want: '양파[1/2개], 된장[2T], 설탕[0.5티스푼], 소금[간맞추기]',
  },
  {
    name: 'long notes in brackets, (약 …) after an amount, 준비물 and 주의사항 end the list (app.notion.com page)',
    text: '쿠키 케이크\n재료\n- 쿠키 30개 (20개는 크림을 분리하고, 나머지는 장식에 사용)\n- 휘핑크림 500ml\n- 설탕 30g (약 3큰술)\n- 크림치즈 200g (실온에 두기)\n- 준비물: 사각 용기, 유산지\n주의사항\n- 크림은 천천히 섞는다.',
    want: '쿠키[30개], 휘핑크림[500ml], 설탕[30g], 크림치즈[200g]',
  },
  {
    name: 'amount first ("125g 버터"); nested and open brackets in the heading (youtu.be/cqsDfPlwFMs)',
    text: '👩🏻‍🍳 재료 (정사각 팬 (가로세로 16cm 1개분량) - 원래 레시피 반만 했어요.\n125g 무염버터\n38g 코코아파우더 (13g+25g)\n225g 백설탕\n150g 계란\n토핑용 소금 약간\n\n🥄 만드는 법\n1) 초콜릿과 설탕을 섞는다.',
    want: '무염버터[125g], 코코아파우더[38g], 백설탕[225g], 계란[150g], 토핑용 소금[약간]',
  },
  {
    name: 'amounts in brackets on a long comma line; "※ 요리이름 양념" heading (youtu.be/pNtwZuhYQeg)',
    text: '[닭볶음탕]\n※ 재료\n닭(1마리-1.5kg), 감자(2개), 양파(1/2개), 대파(1대), 다진 마늘(넉넉히 1큰술), 식용유\n\n※ 닭볶음탕 양념\n간장(6큰술), 설탕(4큰술), 고추장(3큰술), 후추(취향에 따라 조절)\n\n1. 닭은 흐르는 물에 잘 씻어 핏물을 빼준다.',
    want: '닭[1마리-1.5kg], 감자[2개], 양파[1/2개], 대파[1대], 다진 마늘[넉넉히 1큰술], 식용유, 간장[6큰술], 설탕[4큰술], 고추장[3큰술], 후추[취향에 따라 조절]',
  },
  {
    name: 'no 재료 list at all: nothing found',
    text: '오늘은 엄마표 김치찌개 레시피를 알려드릴게요. 맛있게 드세요!',
    want: '',
  },
];

let failed = 0;
for (const c of cases) {
  const got = show(parseIngredients(c.text));
  if (got === c.want) console.log(`ok    ${c.name}`);
  else { failed++; console.log(`FAIL  ${c.name}\n      want: ${c.want}\n      got:  ${got}`); }
}
console.log(failed ? `\n${failed} of ${cases.length} failed` : `\nall ${cases.length} passed`);
process.exit(failed ? 1 : 0);

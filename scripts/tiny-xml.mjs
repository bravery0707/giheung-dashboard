/**
 * 공공데이터포털 응답의 <item> 블록만 평평한 객체 배열로 바꾸는 최소 파서.
 * 외부 의존성 없이 Node 18+ 에서 그대로 돌아간다.
 */
const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&amp;/g, "&")
  .trim();

export function XMLParser(xml) {
  const items = [];
  // <item> 래퍼를 벗긴 '내용'만 대상으로 필드를 훑는다.
  // (래퍼를 포함한 채로 훑으면 <item>…</item> 자체가 하나의 필드로 잡힌다)
  const re = /<item>([\s\S]*?)<\/item>/g;
  let block;
  while ((block = re.exec(xml))) {
    const inner = block[1];
    const obj = {};
    const field = /<([A-Za-z_][\w.:-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>|<([A-Za-z_][\w.:-]*)(?:\s[^>]*)?\/>/g;
    let m;
    while ((m = field.exec(inner))) {
      if (m[3]) obj[m[3]] = "";          // <tag/>
      else obj[m[1]] = decode(m[2]);
    }
    items.push(obj);
  }
  return items;
}

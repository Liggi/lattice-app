/**
 * Agents draft Slack posts with "•" bullets, one per line under single
 * newlines. Markdown reads those newlines as soft breaks and runs the bullets
 * together into one paragraph, on screen and in a copied selection.
 *
 * This remark plugin turns a soft break before a line starting with "•" into
 * a hard break. Other single newlines in prose still wrap as before, and code
 * is untouched (its text is never a `text` node).
 */

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

const BEFORE_BULLET = /\n(?=[ \t]*•)/;

function splitAtBullets(value: string): MdNode[] {
  return value.split(BEFORE_BULLET).flatMap((part, i) =>
    i === 0 ? [{ type: 'text', value: part }] : [{ type: 'break' }, { type: 'text', value: part }]);
}

function walk(node: MdNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text' && child.value && BEFORE_BULLET.test(child.value)) return splitAtBullets(child.value);
    walk(child);
    return [child];
  });
}

export function remarkSlackBullets() {
  return (tree: MdNode): void => walk(tree);
}

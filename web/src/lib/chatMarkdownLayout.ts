import type { Paragraph, PhrasingContent, Root, RootContent } from "mdast";

function hasVisibleChildren(children: PhrasingContent[]): boolean {
  return children.some((child) => child.type !== "text" || child.value.trim().length > 0);
}

function paragraph(children: PhrasingContent[]): Paragraph {
  return { type: "paragraph", children };
}

function splitImageParagraph(parent: Paragraph): RootContent[] {
  if (!parent.children.some((child) => child.type === "image")) return [parent];

  const blocks: RootContent[] = [];
  let textChildren: PhrasingContent[] = [];

  for (const child of parent.children) {
    if (child.type !== "image") {
      textChildren.push(child);
      continue;
    }

    if (hasVisibleChildren(textChildren)) blocks.push(paragraph(textChildren));
    textChildren = [];
    blocks.push(paragraph([child]));
  }

  if (hasVisibleChildren(textChildren)) blocks.push(paragraph(textChildren));
  return blocks.length > 0 ? blocks : [parent];
}

export function remarkImageParagraphs() {
  return (tree: Root) => {
    for (let index = 0; index < tree.children.length; index += 1) {
      const child = tree.children[index];
      if (child?.type !== "paragraph") continue;
      const replacement = splitImageParagraph(child);
      if (replacement.length === 1 && replacement[0] === child) continue;
      tree.children.splice(index, 1, ...replacement);
      index += replacement.length - 1;
    }
  };
}

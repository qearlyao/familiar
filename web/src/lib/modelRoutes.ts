/** A model id is gateway + optional sub-route + leaf name. The same leaf can arrive by two
    gateways (anthropic/claude-fable-5 and link/claude-fable-5 are different models), and
    through one gateway by two vendors (openrouter/google/… and openrouter/openai/…).
    So the list groups by gateway, and any sub-route rides along on the row. */

export const modelLeaf = (model: string) => model.slice(model.lastIndexOf("/") + 1);

/** The part of the id a row must still show: under a gateway header only the sub-route
    ("" for a plain provider/model id), in a flat list the whole prefix. */
export const modelRoute = (model: string, grouped: boolean) =>
  grouped ? model.split("/").slice(1, -1).join("/") : model.slice(0, model.lastIndexOf("/"));

export function byGateway(models: readonly string[]): { gateway: string; models: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const model of models) {
    const gateway = model.includes("/") ? model.slice(0, model.indexOf("/")) : "no gateway";
    const list = groups.get(gateway);
    if (list) list.push(model);
    else groups.set(gateway, [model]);
  }
  // One gateway means every header would say the same thing — leave the flat list alone.
  return groups.size > 1 ? [...groups].map(([gateway, list]) => ({ gateway, models: list })) : [];
}

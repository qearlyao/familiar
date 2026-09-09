import { useEffect, useState } from "react";

/** Live answer to a CSS media query, so a component can pick a different shape at a
    breakpoint the stylesheet alone can't reach (a popover on desktop, a sheet on a phone). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

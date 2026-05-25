import {
  BookOpen,
  Clock,
  Compass,
  FileText,
  Globe,
  Image as ImageIcon,
  Pencil,
  Terminal,
  Volume2,
  Wrench,
  type LucideIcon,
} from "lucide-react";

interface IconRule {
  match: (name: string) => boolean;
  icon: LucideIcon;
}

const RULES: IconRule[] = [
  { match: (n) => /^(web_)?search/.test(n) || /web/.test(n), icon: Globe },
  { match: (n) => /^(read|cat|ls|view|list_files)/.test(n), icon: FileText },
  { match: (n) => /^(write|edit|patch|create_file)/.test(n), icon: Pencil },
  { match: (n) => /^(bash|shell|exec|terminal)/.test(n), icon: Terminal },
  { match: (n) => /^memory/.test(n), icon: BookOpen },
  { match: (n) => /^(tts|speak|voice)/.test(n), icon: Volume2 },
  { match: (n) => /^(image|meme|picture|photo)/.test(n), icon: ImageIcon },
  { match: (n) => /^skill/.test(n), icon: Compass },
];

export function iconForTool(name: string): LucideIcon {
  const normalized = name.toLowerCase();
  for (const rule of RULES) {
    if (rule.match(normalized)) return rule.icon;
  }
  return Wrench;
}

export const ThinkingIcon = Clock;

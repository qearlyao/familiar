import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/** words as a reader would count them */
export const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

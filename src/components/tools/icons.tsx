import {
  ClipboardList,
  Combine,
  Crop,
  FileImage,
  FileOutput,
  FilePen,
  FilePlus,
  FormInput,
  Highlighter,
  Image,
  Images,
  Layers,
  LayoutGrid,
  ListOrdered,
  MessageSquareText,
  RotateCw,
  Scissors,
  Signature,
  Stamp,
  Trash2,
  type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  ClipboardList,
  Combine,
  Crop,
  FileImage,
  FileOutput,
  FilePen,
  FilePlus,
  FormInput,
  Highlighter,
  Image,
  Images,
  Layers,
  LayoutGrid,
  ListOrdered,
  MessageSquareText,
  RotateCw,
  Scissors,
  Signature,
  Stamp,
  Trash2,
};

export function ToolIcon({ name, size = 22 }: { name: string; size?: number }) {
  const Icon = ICONS[name] ?? FilePen;
  return <Icon size={size} aria-hidden="true" />;
}

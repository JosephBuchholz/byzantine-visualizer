import { createContext } from "react";

export type Theme = "light" | "dark";

export interface ThemeCTX {
  theme: Theme;
  getColor: (color: string) => string | undefined;
  onChangeTheme: (theme: Theme) => void;
}

export const ThemeContext = createContext<ThemeCTX | undefined>(undefined);

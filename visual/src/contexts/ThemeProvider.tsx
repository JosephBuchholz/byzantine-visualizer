import { useState } from "react";
import { ThemeContext, type Theme, type ThemeCTX } from "./ThemeContext";

function getTailwindColor(colorName: string) {
  const rootStyles = getComputedStyle(document.documentElement);

  const cssVariableName = `--color-${colorName}`;
  const colorValue = rootStyles.getPropertyValue(cssVariableName).trim();
  return colorValue || undefined;
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("light");

  const getColor = (color: string) => {
    return getTailwindColor(color);
  };

  const onChangeTheme = (theme: Theme) => {
    setTheme(theme);
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  };

  const themeValue: ThemeCTX = {
    theme: theme,
    getColor: getColor,
    onChangeTheme: onChangeTheme,
  };

  return (
    <ThemeContext.Provider value={themeValue}>
      <div>{children}</div>
    </ThemeContext.Provider>
  );
}

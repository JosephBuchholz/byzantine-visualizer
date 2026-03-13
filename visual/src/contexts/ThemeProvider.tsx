import { useEffect, useState } from "react";
import { ThemeContext, type Theme, type ThemeCTX } from "./ThemeContext";

function getTailwindColor(colorName: string) {
  const rootStyles = getComputedStyle(document.documentElement);

  const cssVariableName = `--color-${colorName}`;
  const colorValue = rootStyles.getPropertyValue(cssVariableName).trim();
  return colorValue || undefined;
}

function changeTheme(theme: "dark" | "light") {
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const defaultIsDarkMode = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  const defaultMode = defaultIsDarkMode ? "dark" : "light";
  const [theme, setTheme] = useState<Theme>(defaultMode);

  useEffect(() => {
    changeTheme(defaultMode)
  }, [defaultMode]);

  const getColor = (color: string) => {
    return getTailwindColor(color);
  };

  const onChangeTheme = (theme: Theme) => {
    setTheme(theme);
    changeTheme(theme);
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

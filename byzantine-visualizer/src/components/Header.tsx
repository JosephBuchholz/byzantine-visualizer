import { useTheme } from "../hooks/useTheme";

export default function Header() {
  const { theme: theme, onChangeTheme: onChangeTheme } = useTheme();

  return (
    <div className="flex flex-row w-full justify-between bg-header">
      <h1 className="font-semibold m-4 text-text">HotStuff BFT Visualizer</h1>
      <button
        className="h-min p-2 cursor-pointer text-text-on-primary bg-primary rounded-md self-center m-2 mr-4"
        onClick={() => {
          onChangeTheme(theme === "light" ? "dark" : "light");
        }}
      >
        {theme === "light" ? "Change to Dark" : "Change to Light"}
      </button>
    </div>
  );
}

import Header from "./components/Header";
import ThemeProvider from "./contexts/ThemeProvider";
import Main from "./components/Main";

export default function App() {
  return (
    <ThemeProvider>
      <Header></Header>
      <Main />
    </ThemeProvider>
  );
}

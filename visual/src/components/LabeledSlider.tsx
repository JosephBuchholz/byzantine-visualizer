import { Slider } from "@mui/material";
import { useTheme } from "../hooks/useTheme";

export default function LabeledSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const { getColor } = useTheme();

  return (
    <div className="flex flex-row m-2 items-center">
      <p className="text-text font-semibold font-primary">{label}</p>
      <Slider
        className="m-2 ml-6"
        sx={{
          "& .MuiSlider-thumb": {
            color: getColor("secondary"),
          },
          "& .MuiSlider-track": {
            color: getColor("secondary"),
          },
          "& .MuiSlider-rail": {
            color: "#acc4e4",
          },
        }}
        value={value}
        onChange={(_, newValue) => onChange(newValue as number)}
      ></Slider>
    </div>
  );
}

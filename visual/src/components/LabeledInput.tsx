
export default function LabeledSlider({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange?: (value: string) => void;
}) {
  return (
    <div className="m-2">
      <p className="text-text mb-2 font-semibold font-primary">{label}</p>
      <input
        type="text"
        placeholder={placeholder}
        className="bg-input text-text placeholder:text-text-dim p-1 bg-secondary border border-accent focus:outline-none focus:ring-2 focus:ring-accent"
        value={value}
        onChange={(e) => onChange && onChange(e.target.value)}
      />
    </div>
  );
}

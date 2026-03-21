
export default function LabeledNumericInput({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="m-2">
      <p className="text-text mb-2 font-semibold font-primary">{label}</p>
      <input
        type="number"
        placeholder={placeholder}
        className="bg-input text-text placeholder:text-text-dim p-1 bg-secondary border border-accent focus:outline-none focus:ring-2 focus:ring-accent"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      />
    </div>
  );
}


import Image from "next/image";

/**
 * The Flapjack mark. Swap `MARK` to any file in /public/brand to rebrand the
 * whole app in one place (see /brand/index.html for the 5 options).
 */
const MARK = "/brand/option-1-stack.svg";

export function Logo({ size = 28 }: { size?: number }) {
  return <Image src={MARK} alt="Flapjack" width={size} height={size} priority />;
}

export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2">
      <Logo size={size} />
      <span className="text-lg font-extrabold tracking-tight text-white">Flapjack</span>
    </span>
  );
}

import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = [
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // New in eslint-config-next 16 (React Compiler era). Our effects that reset state on open/navigation are
      // deliberate and covered by tests; keep the hint visible without failing the build.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    ignores: ['node_modules/**', '.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'public/pdfjs/**'],
  },
];

export default eslintConfig;

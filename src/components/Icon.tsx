import { memo } from 'react';

const paths: Record<string, string> = {
  upload: 'M12 3v12m0-12 4 4m-4-4-4 4M4 17v3h16v-3',
  download: 'M12 3v12m0 0 4-4m-4 4-4-4M4 17v3h16v-3',
  sync: 'M20 7h-5a5 5 0 0 0-8-2M4 17h5a5 5 0 0 0 8 2M20 7V3m0 4h-4M4 17v4m0-4h4',
  search: 'M10.5 18a7.5 7.5 0 1 1 5.3-12.8 7.5 7.5 0 0 1-5.3 12.8Zm5.5-2 4 4',
  filter: 'M4 6h16M7 12h10M10 18h4',
  cards: 'M4 7h16v12H4zM7 4h10',
  users: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 20a6 6 0 0 1 12 0M14 20a5 5 0 0 1 7-4.5',
  check: 'm5 13 4 4L19 7',
  x: 'M6 6l12 12M18 6 6 18',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  sun: 'M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z'
};

export type IconName = keyof typeof paths;

export const Icon = memo(function Icon({ name }: { name: IconName }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="icon">
      <path d={paths[name]} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
});

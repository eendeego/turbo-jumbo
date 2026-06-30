import * as stylex from '@stylexjs/stylex';
import {Button} from '@astryxdesign/core';
import {
  colorVars,
  spacingVars,
  radiusVars,
} from '@astryxdesign/core/theme/tokens.stylex';

// Smoke test for the StyleX + xstyle pipeline against Astryx tokens.
// Safe to replace once real pages exist.
const styles = stylex.create({
  main: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacingVars['--spacing-4'],
    padding: spacingVars['--spacing-8'],
    backgroundColor: colorVars['--color-background-surface'],
    color: colorVars['--color-text-primary'],
    borderRadius: radiusVars['--radius-container'],
  },
  cta: {
    alignSelf: 'flex-start',
  },
});

export default function Page() {
  return (
    <main {...stylex.props(styles.main)}>
      <h1>Turbo Jumbo</h1>
      <Button label="Save…" variant="primary" xstyle={styles.cta} />
    </main>
  );
}

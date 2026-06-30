'use client';

import {useEffect, useState} from 'react';
import * as stylex from '@stylexjs/stylex';
import {Section} from '@astryxdesign/core/Section';
import {VStack, HStack, StackItem} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Badge} from '@astryxdesign/core/Badge';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {
  getEntries,
  subscribe,
  LEVELS,
  type LogEntry,
  type LogLevel,
} from '@/lib/client-log';

const styles = stylex.create({
  scroll: {maxHeight: '16rem', overflowY: 'auto'},
});

const LEVEL_VARIANT: Record<
  LogLevel,
  'error' | 'warning' | 'info' | 'neutral'
> = {
  error: 'error',
  warn: 'warning',
  info: 'info',
  debug: 'neutral',
  trace: 'neutral',
};

export function LogSection({logLevel}: {logLevel: string}) {
  const [entries, setEntries] = useState<LogEntry[]>(getEntries);

  useEffect(() => subscribe(() => setEntries(getEntries())), []);

  const configLevel = (logLevel in LEVELS ? logLevel : 'info') as LogLevel;
  // Newest first so live entries appear at the top without scroll juggling.
  const visible = entries
    .filter((e) => LEVELS[e.level] <= LEVELS[configLevel])
    .slice()
    .reverse();

  return (
    <Section>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center">
          <Heading level={2}>Operation log</Heading>
          <Badge variant="neutral" label={logLevel} />
        </HStack>
        {visible.length === 0 ? (
          <EmptyState title="No log entries yet" />
        ) : (
          <VStack gap={1} xstyle={styles.scroll}>
            {visible.map((e, i) => (
              <HStack key={i} gap={2} vAlign="center">
                <Text type="code" color="secondary">
                  {e.ts.slice(11, 19)}
                </Text>
                <Badge variant={LEVEL_VARIANT[e.level]} label={e.level} />
                <StackItem size="fill">
                  <Text type="code">{e.msg}</Text>
                </StackItem>
              </HStack>
            ))}
          </VStack>
        )}
      </VStack>
    </Section>
  );
}

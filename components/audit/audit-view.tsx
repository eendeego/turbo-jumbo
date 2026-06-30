'use client';

import {useState} from 'react';
import {VStack, HStack} from '@astryxdesign/core/Stack';
import {Button} from '@astryxdesign/core/Button';
import {Badge} from '@astryxdesign/core/Badge';
import {Banner} from '@astryxdesign/core/Banner';
import {List, ListItem} from '@astryxdesign/core/List';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import type {AuditResult, AuditStatus} from '@/lib/audit';

const STATUS_LABEL: Record<AuditStatus, string> = {
  pass: 'Pass',
  incomplete: 'Incomplete',
  'checksum-mismatch': 'Checksum mismatch',
  misplaced: 'Misplaced',
  unverifiable: 'Unverifiable',
  error: 'Error',
};

const STATUS_VARIANT: Record<
  AuditStatus,
  'success' | 'warning' | 'error' | 'neutral'
> = {
  pass: 'success',
  incomplete: 'error',
  'checksum-mismatch': 'error',
  misplaced: 'warning',
  unverifiable: 'neutral',
  error: 'error',
};

export function AuditView({location}: {location: 'local' | 'cold-storage'}) {
  const [results, setResults] = useState<AuditResult[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runAudit() {
    setRunning(true);
    setError(null);
    setResults([]);
    try {
      const res = await fetch('/api/v1/audit', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({location}),
      });
      if (!res.ok || !res.body) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        buf += dec.decode(value, {stream: true});
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) {
            const result = JSON.parse(line) as AuditResult;
            setResults((prev) => [...prev, result]);
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <VStack gap={3}>
      <HStack>
        <Button
          label={running ? 'Auditing…' : 'Run audit'}
          variant="secondary"
          size="sm"
          isDisabled={running}
          onClick={runAudit}
        />
      </HStack>
      {error && <Banner status="error" title={`Error: ${error}`} />}
      {results.length === 0 ? (
        <EmptyState title="No audit results yet" />
      ) : (
        <List hasDividers>
          {results.map((r) => (
            <ListItem
              key={r.file}
              label={r.file}
              description={r.message}
              endContent={
                <Badge
                  variant={STATUS_VARIANT[r.status]}
                  label={STATUS_LABEL[r.status]}
                />
              }
            />
          ))}
        </List>
      )}
    </VStack>
  );
}

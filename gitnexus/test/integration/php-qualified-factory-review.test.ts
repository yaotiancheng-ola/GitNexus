import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('PHP qualified factory review boundaries', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'php-factory-review-'));
    const sources = {
      'same-name.php':
        '<?php namespace Ns; class Product { function ping() {} } function make(): Product { return new Product(); } class make { function ping() {} }',
      'caller.php':
        '<?php function callResult() { $x = Ns\\make(); $x->ping(); } function inlineCallResult() { Ns\\make()->ping(); }',
      'absolute.php': '<?php function absoluteResult() { $x = \\Ns\\make(); $x->ping(); }',
      'relative.php':
        '<?php namespace Ns; function relativeResult() { $x = namespace\\make(); $x->ping(); } function bareClosureResult() { $f = make(...); $f->ping(); }',
      'duplicate-one.php':
        '<?php namespace Dup; class Product { function ping() {} } function make(): Product { return new Product(); }',
      'duplicate-two.php': '<?php namespace Dup { function make() {} } namespace Other {}',
      'duplicate-caller.php': '<?php function duplicateResult() { $x = Dup\\make(); $x->ping(); }',
      'semicolon-one.php':
        '<?php namespace Semi; class Product { function ping() {} } function make(): Product { return new Product(); }',
      'semicolon-two.php':
        '<?php namespace OtherSemi; function unrelated() {} namespace Semi; function make() {}',
      'semicolon-caller.php':
        '<?php function semicolonDuplicateResult() { $x = Semi\\make(); $x->ping(); }',
      'long-one.php':
        '<?php namespace LongDup; class Product { function ping() {} } function make(): Product { return new Product(); }',
      'long-two.php':
        '<?php namespace LongDup { function make() {} } /*' +
        'x'.repeat(40000) +
        '*/ namespace OtherLong {}',
      'long-caller.php':
        '<?php function longDuplicateResult() { $x = LongDup\\make(); $x->ping(); }',
      'first-class.php':
        '<?php namespace Caller; use Ns as rp; class LocalProduct { function ping() {} } function localMake(): LocalProduct { return new LocalProduct(); } function closureResult() { $f = rp\\make(...); $f->ping(); } function relativeClosureResult() { $f = namespace\\localMake(...); $f->ping(); }',
      'positive.php':
        '<?php namespace Plain; class Expected { function ping() {} } function make(): Expected { return new Expected(); }',
      'positive-caller.php': '<?php function positiveResult() { $x = Plain\\make(); $x->ping(); }',
      'scoped-producer.php':
        '<?php namespace Producer; class Product { function ping() {} } function make(): Product { return new Product(); }',
      'scoped-caller.php':
        '<?php namespace Consumer; class Product { function ping() {} } function producerOwner() { $x = \\Producer\\make(); $x->ping(); } function inlineProducerOwner() { \\Producer\\make()->ping(); }',
      'member-first-class.php':
        '<?php class Result { function ping() {} } class Service { function make(): Result { return new Result(); } static function build(): Result { return new Result(); } } function memberClosure() { $s = new Service(); $f = $s->make(...); $f->ping(); } function staticClosure() { $f = Service::build(...); $f->ping(); }',
      'multi-producer.php':
        '<?php namespace Wrong; class AmbiguousProduct { function ping() {} } namespace Real; class AmbiguousProduct { function ping() {} } function make(): AmbiguousProduct { return new AmbiguousProduct(); }',
      'multi-producer-caller.php':
        '<?php function unsafeProducer() { $x = \\Real\\make(); $x->ping(); } function unsafeInlineProducer() { \\Real\\make()->ping(); }',
      'inline-first-class.php': '<?php function inlineClosureResult() { \\Ns\\make(...)->ping(); }',
      'annotation-factory.php':
        '<?php namespace TypeLib; class AnnotationProduct { function ping() {} } function ExternalType(): AnnotationProduct { return new AnnotationProduct(); }',
      'annotation-caller.php':
        '<?php function externalParameter(\\TypeLib\\ExternalType $value) { $value->ping(); } class ConsumerField { public \\TypeLib\\ExternalType $value; public function externalField() { $this->value->ping(); } }',
    };
    for (const [file, source] of Object.entries(sources))
      await fs.writeFile(path.join(root, file), source);
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  const calls = (caller: string, callee?: string) =>
    [...result.graph.iterRelationships()].filter(
      (edge) =>
        edge.type === 'CALLS' &&
        result.graph.getNode(edge.sourceId)?.properties.name === caller &&
        (callee === undefined || result.graph.getNode(edge.targetId)?.properties.name === callee),
    );
  const owner = (method: string) =>
    [...result.graph.iterRelationships()].find(
      (edge) => edge.type === 'HAS_METHOD' && edge.targetId === method,
    )?.sourceId;
  it.each(['externalParameter', 'externalField'])(
    '%s never treats a qualified class annotation as a factory invocation',
    (caller) => {
      expect(calls(caller, 'ping')).toEqual([]);
    },
  );
  it.each(['unsafeProducer', 'unsafeInlineProducer'])(
    '%s refuses a producer with unowned return annotations',
    (caller) => {
      expect(calls(caller, 'ping')).toEqual([]);
    },
  );
  it.each(['callResult', 'inlineCallResult', 'absoluteResult', 'relativeResult'])(
    'types %s from the function when a class shares its name',
    (caller) => {
      const targets = calls(caller, 'ping');
      expect(targets).toHaveLength(1);
      expect(result.graph.getNode(owner(targets[0]!.targetId)!)?.properties.name).toBe('Product');
    },
  );
  it.each(['duplicateResult', 'semicolonDuplicateResult', 'longDuplicateResult'])(
    'retains %s duplicate evidence from multi-namespace files',
    (caller) => {
      expect(calls(caller)).toEqual([]);
    },
  );
  it.each(['closureResult', 'relativeClosureResult', 'bareClosureResult'])(
    '%s does not invoke or inherit the factory return class',
    (caller) => {
      expect(calls(caller)).toEqual([]);
    },
  );
  it.each(['memberClosure', 'staticClosure', 'inlineClosureResult'])(
    '%s does not type a Closure as its eventual return',
    (caller) => {
      expect(calls(caller, 'ping')).toEqual([]);
    },
  );
  it.each(['producerOwner', 'inlineProducerOwner'])(
    '%s reads the return type in the producer scope',
    (caller) => {
      expect(calls(caller, 'ping').map((edge) => edge.targetId)).toEqual([
        'Method:scoped-producer.php:Product.ping#0',
      ]);
    },
  );
  it('retains the ordinary qualified factory result', () => {
    const targets = calls('positiveResult', 'ping');
    expect(targets).toHaveLength(1);
    expect(result.graph.getNode(owner(targets[0]!.targetId)!)?.properties.name).toBe('Expected');
  });
});

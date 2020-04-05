
import { CfnElement } from "../cfn-element";
import { CfnOutput } from "../cfn-output";
import { CfnParameter } from "../cfn-parameter";
import { Construct } from "../construct-compat";
import { Reference } from "../reference";
import { IResolvable } from "../resolvable";
import { Stack } from "../stack";
import { Token } from "../token";
import { CfnReference } from "./cfn-reference";
import { Intrinsic } from './intrinsic';
import { findTokens } from "./resolve";
import { makeUniqueId } from "./uniqueid";

export function prepareReferences(root: Construct) {
  const refs = findAllReferences(root);

  for (const ref of refs) {
    const consumerStack = Stack.of(ref.consumer);
    const producerStack = Stack.of(ref.producer);

    // skip if this is not a cross-stack reference
    if (producerStack === consumerStack) {
      return;
    }

    // if the reference has already been assigned a value for the consuming stack, carry on.
    if (!ref.reference.hasValueForStack(consumerStack)) {
      const value = getValueForReference(consumerStack, producerStack, ref.reference);
      ref.reference.assignValueForStack(consumerStack, value);
    }
  }
}

interface Ref {
  readonly refid: string;
  readonly consumer: CfnElement;
  readonly producer: Construct;
  readonly reference: CfnReference;
}

function getValueForReference(consumer: Stack, producer: Stack, reference: Reference): IResolvable {
  // unsupported: stacks from different apps
  if (producer.node.root !== consumer.node.root) {
    throw new Error(
      `Cannot reference across apps. ` +
      `Consuming and producing stacks must be defined within the same CDK app.`);
  }

  // unsupported: stacks are not in the same environment
  if (producer.environment !== consumer.environment) {
    throw new Error(
      `Stack "${consumer.node.path}" cannot consume a cross reference from stack "${producer.node.path}". ` +
      `Cross stack references are only supported for stacks deployed to the same environment or between nested stacks and their parent stack`);
  }

  // TODO: once we move deps to this loop
  // sourceStack.node.addDependency(targetStack);

  // reference between two top-level stacks in the same environment
  if (!consumer.nested && !producer.nested) {
    // add a dependency on the producing stack - it has to be deployed before this stack can consume the exported value
    // if the producing stack is a nested stack (i.e. has a parent), the dependency is taken on the parent.
    const producerDependency = producer.nestedStackParent ? producer.nestedStackParent : producer;
    const consumerDependency = consumer.nestedStackParent ? consumer.nestedStackParent : consumer;
    consumerDependency.addDependency(producerDependency, `${consumer.node.path} -> ${reference.target.node.path}.${reference.displayName}`);

    return exportAndGetImportValue(reference);
  }

  // if the consuming stack is a child of the producing stack, then wire the reference through
  // a CloudFormation parameter on the nested stack.
  if (isParentOfNestedStack(producer, consumer)) {
    return getCreateParameterForReference(consumer, reference);
  }

  // if the consumer is a parent of the producer, then wire the reference by creating an
  // output on the nested stack and referencing it through a GetAtt.Outputs attribute.
  if (isParentOfNestedStack(consumer, producer)) {
    return getCreateOutputForReference(producer, reference);
  }

  // sibling nested stacks (same parent):
  // output from one and pass as parameter to the other
  if (producer.nestedStackParent && producer.nestedStackParent === consumer.nestedStackParent) {
    const outputValue = getCreateOutputForReference(producer, reference);
    return getCreateParameterForReference(consumer, outputValue);
  }

  // sibling nested stacks (same parent):
  // output from one and pass as parameter to the other
  if (consumer.nestedStackParent && producer.nestedStackParent && producer.nestedStackParent === consumer.nestedStackParent) {
    const outputValue = getCreateOutputForReference(consumer, reference);
    return getCreateParameterForReference(consumer, outputValue);
  }

  // nested stack references a value from some other non-nested stack:
  // normal export/import, with dependency between the parents
  if (producer.nestedStackParent && consumer.nestedStackParent && consumer.nestedStackParent !== producer) {
    return getValueForReference(consumer.nestedStackParent, producer, reference);
  }

  // nested stack references a value from some other non-nested stack:
  // normal export/import, with dependency between the parents
  if (consumer.nestedStackParent && consumer.nestedStackParent !== producer) {
    return getValueForReference(consumer.nestedStackParent, producer, reference);
  }

  // some non-nested stack (that is not the parent) references a resource inside the nested stack:
  // we output the value and let our parent export it
  if (producer.nestedStackParent && !consumer.nestedStackParent && producer.nestedStackParent && producer.nestedStackParent !== consumer) {
    const outputValue = getCreateOutputForReference(producer, reference);
    return getValueForReference(consumer, producer.nestedStackParent, outputValue);
  }

  throw new Error('unexpected nested stack cross reference');
}

/**
 * Returns all the tokens used within the scope of the current stack.
 */
function findAllReferences(root: Construct) {
  const result = new Array<Ref>();
  for (const source of root.node.findAll()) {
    if (!CfnElement.isCfnElement(source)) {
      continue;
    }

    try {
      const tokens = findTokens(source, () => source._toCloudFormation());
      for (const token of tokens) {
        if (CfnReference.isCfnReference(token)) {
          const refid = JSON.stringify({
            consumer: source.node.path,
            producer: token.target.node.path,
            ref: token.displayName
          });

          if (!(token.target instanceof Construct)) {
            throw new Error(`objects that implement IConstruct must extend "Construct"`);
          }

          result.push({
            refid,
            producer: token.target,
            consumer: source,
            reference: token
          });
        }
      }
    }  catch (e) {
      // Note: it might be that the properties of the CFN object aren't valid.
      // This will usually be preventatively caught in a construct's validate()
      // and turned into a nicely descriptive error, but we're running prepare()
      // before validate(). Swallow errors that occur because the CFN layer
      // doesn't validate completely.
      //
      // This does make the assumption that the error will not be rectified,
      // but the error will be thrown later on anyway. If the error doesn't
      // get thrown down the line, we may miss references.
      if (e.type === 'CfnSynthesisError') {
        continue;
      }

      throw e;
    }
  }

  return result;
}

/**
 * Imports a value from another stack by creating an "Output" with an "ExportName"
 * and returning an "Fn::ImportValue" token.
 */
function exportAndGetImportValue(reference: Reference): IResolvable {
  const exportingStack = Stack.of(reference.target);

  // Ensure a singleton "Exports" scoping Construct
  // This mostly exists to trigger LogicalID munging, which would be
  // disabled if we parented constructs directly under Stack.
  // Also it nicely prevents likely construct name clashes
  const exportsScope = getCreateExportsScope(exportingStack);

  // Ensure a singleton CfnOutput for this value
  const resolved = exportingStack.resolve(reference);
  const id = 'Output' + JSON.stringify(resolved);
  const exportName = generateExportName(exportsScope, id);
  const output = exportsScope.node.tryFindChild(id) as CfnOutput;
  if (!output) {
    new CfnOutput(exportsScope, id, { value: Token.asString(reference), exportName });
  }

  // We want to return an actual FnImportValue Token here, but Fn.importValue() returns a 'string',
  // so construct one in-place.
  return new Intrinsic({ 'Fn::ImportValue': exportName });
}

function getCreateExportsScope(stack: Stack) {
  const exportsName = 'Exports';
  let stackExports = stack.node.tryFindChild(exportsName) as Construct;
  if (stackExports === undefined) {
    stackExports = new Construct(stack, exportsName);
  }

  return stackExports;
}

function generateExportName(stackExports: Construct, id: string) {
  const stack = Stack.of(stackExports);
  const components = [...stackExports.node.scopes.slice(2).map(c => c.node.id), id];
  const prefix = stack.stackName ? stack.stackName + ':' : '';
  const exportName = prefix + makeUniqueId(components);
  return exportName;
}

//////////////////////////////////////
// NESTED STACKS
//////////////////////////////////////

function getCreateParameterForReference(consumer: Stack, reference: Reference) {
  // we call "this.resolve" to ensure that tokens do not creep in (for example, if the reference display name includes tokens)
  const paramId = consumer.resolve(`reference-to-${reference.target.node.uniqueId}.${reference.displayName}`);
  let param = consumer.node.tryFindChild(paramId) as CfnParameter;
  if (!param) {
    param = new CfnParameter(consumer, paramId, { type: 'String' });

    // Ugly little hack until we move NestedStack to this module.
    if (!('setParameter' in consumer)) {
      throw new Error(`assertion failed: nested stack should have a "setParameter" method`);
    }

    (consumer as any).setParameter(param.logicalId, Token.asString(reference));
  }

  return param.value;
}

function getCreateOutputForReference(producer: Stack, reference: Reference) {
  const outputId = `${reference.target.node.uniqueId}${reference.displayName}`;
  let output = producer.node.tryFindChild(outputId) as CfnOutput;
  if (!output) {
    output = new CfnOutput(producer, outputId, { value: Token.asString(reference) });
  }

  if (!producer.nestedStackResource) {
    throw new Error('assertion failed');
  }

  return producer.nestedStackResource.getAtt(`Outputs.${output.logicalId}`);
}

/**
 * @returns true if this stack is a direct or indirect parent of the nested
 * stack `nested`. If `nested` is a top-level stack, returns false.
 */
export function isParentOfNestedStack(parent: Stack, child: Stack): boolean {
  // if "nested" is not a nested stack, then by definition we cannot be its parent
  if (!child.nestedStackParent) {
    return false;
  }

  // if this is the direct parent, then we found it
  if (parent === child.nestedStackParent) {
    return true;
  }

  // traverse up
  return isParentOfNestedStack(parent, child.nestedStackParent);
}

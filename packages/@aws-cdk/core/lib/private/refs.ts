
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
    const consumer = Stack.of(ref.consumer);

    // skip if this reference already has a value for stack
    if (ref.reference.hasValueForStack(consumer)) {
      continue;
    }

    // if the reference has already been assigned a value for the consuming stack, carry on.
    const value = getValueForReference(ref);
    ref.reference.assignValueForStack(consumer, value);
  }
}

function getValueForReference(ref: Edge): IResolvable {
  const consumer = Stack.of(ref.consumer);
  const producer = Stack.of(ref.reference.target);
  const reference = ref.reference;

  if (producer === consumer) {
    return ref.reference;
  }

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

  // if the consuming stack is a child of the producing stack, then wire the reference through
  // a CloudFormation parameter on the nested stack and continue recursively
  if (isParent(producer, consumer)) {
    const inputValue = createNestedStackParameter(consumer, reference);
    return getValueForReference({ consumer: ref.consumer, reference: inputValue });
  }

  // if the producer is nested, we always publish the value through an output
  // because we can't generate an "export name" for nested stacks (the name
  // includes the stack name, to ensure uniqness), and it only resolves during
  // deployment. Therefore the export name cannot be used in the consuming side,
  // so we simply publish the value through an export and recuse because now the
  // value is basically available in the parent.
  if (producer.nested) {
    const outputValue = createNestedStackOutput(producer, reference);
    return getValueForReference({ consumer: ref.consumer, reference: outputValue });
  }

  // add a dependency on the producing stack - it has to be deployed before this
  // stack can consume the exported value if the producing stack is a nested
  // stack (i.e. has a parent), the dependency is taken on the parent.
  const producerDep = producer.nestedStackParent ?? producer;
  const consumerDep = consumer.nestedStackParent ?? consumer;
  consumerDep.addDependency(producerDep,
    `${consumer.node.path} -> ${reference.target.node.path}.${reference.displayName}`);

  return exportAndGetImportValue(reference);
}

interface Edge {
  readonly consumer: CfnElement;
  readonly reference: CfnReference;
}

/**
 * Returns all the tokens used within the scope of the current stack.
 */
function findAllReferences(root: Construct) {
  const result = new Array<Edge>();
  for (const source of root.node.findAll()) {
    if (!CfnElement.isCfnElement(source)) {
      continue;
    }

    try {
      const tokens = findTokens(source, () => source._toCloudFormation());
      for (const token of tokens) {
        if (CfnReference.isCfnReference(token)) {

          if (!(token.target instanceof Construct)) {
            throw new Error(`objects that implement IConstruct must extend "Construct"`);
          }

          result.push({
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

  if (Token.isUnresolved(exportName)) {
    throw new Error(`unresolved token in generated export name: ${JSON.stringify(exportingStack.resolve(exportName))}`);
  }

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

function createNestedStackParameter(consumer: Stack, reference: Reference) {
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

  return param.value as CfnReference;
}

function createNestedStackOutput(producer: Stack, reference: Reference): CfnReference {
  const outputId = `${reference.target.node.uniqueId}${reference.displayName}`;
  let output = producer.node.tryFindChild(outputId) as CfnOutput;
  if (!output) {
    output = new CfnOutput(producer, outputId, { value: Token.asString(reference) });
  }

  if (!producer.nestedStackResource) {
    throw new Error('assertion failed');
  }

  return producer.nestedStackResource.getAtt(`Outputs.${output.logicalId}`) as CfnReference;
}

/**
 * @returns true if this stack is a direct or indirect parent of the nested
 * stack `nested`. If `nested` is a top-level stack, returns false.
 */
export function isParent(parent: Stack, child: Stack): boolean {
  // if "nested" is not a nested stack, then by definition we cannot be its parent
  if (!child.nestedStackParent) {
    return false;
  }

  // if this is the direct parent, then we found it
  if (parent === child.nestedStackParent) {
    return true;
  }

  // traverse up
  return isParent(parent, child.nestedStackParent);
}

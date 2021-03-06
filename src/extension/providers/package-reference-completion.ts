import * as semver from 'semver';
import * as vscode from 'vscode';
import * as xmldom from 'xmldom';

import { default as axios } from 'axios';

/**
 * Completion provider for PackageReference elements.
 */
export class PackageReferenceCompletionProvider implements vscode.CompletionItemProvider {
    /**
     * The parser for project XML.
     */
    private parser = new xmldom.DOMParser({
        locator: {},
        errorHandler: (level: string, msg: any) => {
            console.log('XMLDOM', level, msg);

            return true;
        }
    });

    // TODO: Implement caching.

    /**
     * The cache for package Ids (keyed by partial package Id).
     */
    private packageIdCache = new Map<string, string[]>();

    /**
     * The cache for package versions (keyed by package Id).
     */
    private packageVersionCache = new Map<string, string[]>();

    /**
     * Create a new {@link PackageReferenceCompletionProvider}.
     * 
     * @param nugetAutoCompleteUrls The URL of the NuGet API end-point to use.
     * @param showNewestVersionsFirst Show newest package versions first?
     */
    constructor(private nugetAutoCompleteUrl: string, private showNewestVersionsFirst: boolean) {}

    /**
     * Provide completion items for the specified document position.
     * 
     * @param document The target document.
     * @param position The position within the target document.
     * @param token A vscode.CancellationToken that can be used to cancel completion.
     * 
     * @returns A promise that resolves to the completion items.
     */
    public provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CompletionList> {
        return this.provideCompletionItemsCore(document, position, token);
    }

    /**
     * Provide completion items for the specified document position.
     * 
     * @param document The target document.
     * @param position The position within the target document.
     * @param token A vscode.CancellationToken that can be used to cancel completion.
     * 
     * @returns {Promise<vscode.CompletionList>} A promise that resolves to the completion item list.
     */
    private async provideCompletionItemsCore(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.CompletionList> {
        const completionItems: vscode.CompletionItem[] = [];
        
        // To keep things simple, we only parse one line at a time (if your PackageReference element spans more than one line, too bad).
        const line = document.lineAt(position);
        const xml = this.parser.parseFromString(line.text);
        const elements = xml.getElementsByTagName('PackageReference');

        const pageSize = 10;

        let packageId: string;
        let packageVersion: string;
        let wantPackageId = false;
        let wantPackageVersion = false;
        let isLocallyFiltered = false;
        for (let i = 0; i < elements.length; i++) {
            const element = elements[i];

            const includeAttribute = element.attributes.getNamedItem('Include');
            if (includeAttribute) {
                packageId = includeAttribute.value;
                wantPackageId = this.isPositionInAttributeValue(position, includeAttribute);
            }

            const versionAttribute = element.attributes.getNamedItem('Version');
            if (versionAttribute) {
                packageVersion = versionAttribute.value;
                wantPackageVersion = this.isPositionInAttributeValue(position, versionAttribute);
            }

            if (wantPackageId || wantPackageVersion)
                break;
        }
        
        if (wantPackageId) {
            // TODO: Use NuGetClient from 'nuget-client'.

            // TODO: Don't hard-code the use of the primary base URL; use Promise.race to call both end-points.
            const response = await axios.get(
                `${this.nugetAutoCompleteUrl}?q=${encodeURIComponent(packageId)}&take=${pageSize}&prerelease=true`
            );

            const availablePackageIds = response.data.data as string[];
            availablePackageIds.sort();
            for (const availablePackageId of availablePackageIds) {
                if (packageId && !availablePackageId.startsWith(packageId)) {
                    isLocallyFiltered = true;

                    continue;
                }

                const completionItem = new vscode.CompletionItem(availablePackageId, vscode.CompletionItemKind.Module);
                completionItems.push(completionItem);  
            }
        } else if (packageId && wantPackageVersion) {
            // TODO: Use NuGetClient from 'nuget-client'.
            
            // TODO: Don't hard-code the use of the primary base URL; use Promise.race to call both end-points.
            const response = await axios.get(
                `${this.nugetAutoCompleteUrl}?id=${encodeURIComponent(packageId)}&take=${pageSize}&prerelease=true`
            );

            const availablePackageVersions = response.data.data as string[];
            availablePackageVersions.sort(
                (version1, version2) => semver.compare(version1, version2)
            );
            if (this.showNewestVersionsFirst)
                availablePackageVersions.reverse();

            if (availablePackageVersions) {
                let sortKey = 0;
                for (const availablePackageVersion of availablePackageVersions) {
                    if (packageVersion && !availablePackageVersion.startsWith(packageVersion)) {
                        isLocallyFiltered = true;
                        
                        continue;
                    }

                    const completionItem = new vscode.CompletionItem(availablePackageVersion, vscode.CompletionItemKind.Value);
                    if (this.showNewestVersionsFirst) {
                        let sortText = sortKey.toString();
                        completionItem.sortText = 'NuGet' + ('000' + sortText).substring(sortText.length);
                    }

                    completionItems.push(completionItem);

                    sortKey++;
                }
            }
        }

        // If the list is locally-filtered or incomplete, VSCode will call us again as the user continues to type.
        const moreResultsAvailable = isLocallyFiltered || completionItems.length >= pageSize;
        
        return new vscode.CompletionList(completionItems, moreResultsAvailable);
    }

    /**
     * Get the text range representing the value of the specified attribute.
     * 
     * @param attribute The attribute.
     * @param line The {@link vscode.TextLine} containing the attribute.
     */
    private getValueRange(attribute: Attr, line: vscode.TextLine): vscode.Range {
        const valueStart: number = (<any>attribute).columnNumber + 1;
        const valueEnd: number = valueStart + attribute.value.length;

        return new vscode.Range(
            new vscode.Position(line.lineNumber, valueStart),
            new vscode.Position(line.lineNumber, valueEnd)
        );
    }

    /**
     * Add package Id suggestion results to the cache.
     * 
     * @param partialPackageId The partial package Id.
     * @param packageIds The matching package Ids.
     */
    private addToPackageIdCache(partialPackageId: string, packageIds: string[]): void {
        this.packageIdCache.set(partialPackageId, packageIds);
    }

    /**
     * Add available package version results to the cache.
     * 
     * @param partialPackageId The package Id.
     * @param packageIds The matching package versions.
     */
    private addToPackageVersionCache(packageId: string, versions: string[]): void {
        this.packageVersionCache.set(packageId, versions);
    }

    /**
     * Determine whether the position lies within the value of the specified attribute.
     * 
     * @param position The position.
     * @param attribute The attribute.
     */
    private isPositionInAttributeValue(position: vscode.Position, attribute: Attr): boolean {
        position = position.translate({
            characterDelta: 1
        });
        
        const valueStart: number = (<any>attribute).columnNumber + 1;
        const valueEnd: number = valueStart + attribute.value.length;

        console.log(`${attribute.name}(${position.character}/${valueStart}-${valueEnd})`);
        
        return (position.character >= valueStart && position.character <= valueEnd);
    }

    /**
     * Get the text range representing the value of the specified attribute.
     * 
     * @param line The line containing the attribute.
     * @param attribute The attribute.
     * @returns {vscode.Range} A {@link vscode.Range} containing the attribute's value.
     */
    private getAttributeValueRange(line: vscode.TextLine, attribute: Attr): vscode.Range {
        const valueStart: number = (<any>attribute).columnNumber - 1;
        const valueEnd: number = valueStart + attribute.value.length;

        console.log(`${attribute.name}(/${valueStart}-${valueEnd})`);
    
        return new vscode.Range(
            new vscode.Position(line.lineNumber, valueStart),
            new vscode.Position(line.lineNumber, valueStart)
        );
    }
}

/**
 * Get the current end-points URLs for the NuGet v3 AutoComplete API.
 */
export async function getNuGetV3AutoCompleteEndPoints(): Promise<string[]> {
    const nugetIndexResponse = await axios.get('https://api.nuget.org/v3/index.json');
    
    const index: NuGetIndex = nugetIndexResponse.data;
    const autoCompleteEndPoints = index.resources
        .filter(
            resource => resource['@type'] === 'SearchAutocompleteService'
        )
        .map(
            resource => resource['@id']
        );

    return autoCompleteEndPoints;
}

/**
 * Represents the index response from the NuGet v3 API.
 */
interface NuGetIndex {
    /**
     * Available API resources.
     */
    resources: NuGetApiResource[];
}

/**
 * Represents a NuGet API resource.
 */
interface NuGetApiResource {
    /**
     * The resource Id (end-point URL).
     */
    '@id': string;

    /**
     * The resource type.
     */
    '@type': string;

    /**
     * An optional comment describing the resource.
     */
    comment?: string;
}

The main feature of any page should always occupt the most visual field for the user in the screen.
No too many colors
Clear visual hierarchy
Don't have too many buttons too close together. If possible, make sure it's deep into the second or third layers (a three dot configure button that opens up more buttons) instead of spread everything out on the first layer. Never have too many rows of buttons.
Always use browser tools or ios simulator and take screenshots to test how the actual UI looks like in any screen size.
No repeating text or add text that do not add any value. Never have too much text that adds no values. Whenever there's a chance to cut down on the text, do it. It's hard to infer from code because many different variables could end up converging to the same exact text, so always make sure to be empiricial and have the subagents actually test the implementations with a wide variety of data and majors.
Never use the browser's default form controls — no native dropdowns and no native number steppers with the tiny up/down arrows. Always the app's styled controls.
Filter panels live on the right side of the page. On phones they open from a button and close when the user scrolls down — never a collapse button.
Never have red text.
In the iOS always make sure the configuration panel or the floating panel can be collapsed. Filter panel or configuration panel or any floating panel should like popup from the bottom navigation bar and the user should be able to close it by clicking outside or scroll down to close it.
Never leave awkward empty spaces, like some gaps here, some gaps there. There's a better way to design than this.
When you have buttons like "back" or "next" at the bottom of a form, and then each step or page of the forms has a different number or composition of elements inside, then if you didn't deal with it these buttons will keep shifting up and down which is a horrible user experience that we must avoid.
Add more spaces between elements to dinstinguish them. This is not the same as leaving too much gap due to awkward designs.
When implementing design choices, always ask these questions:
- Are the most common user actions accessible on the first level or can users easily find where to take these actions on the app? You could use data-driven analysis with Posthog CLI to do that.
- Do we have too many buttons on the first layer? If yes, try to move the actions not used as much hidden to the second or third layers.
- Are the main feature where the user spends the most time interacting with occupying the most visual field? Again, we could also use data-driven analysis as well.
- When the user lands on the page. Do they know what to click and scroll to achieve the actions they want to take? Everything must be as clean, intuitive, and user-friendly as possible.

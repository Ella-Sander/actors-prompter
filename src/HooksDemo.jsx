import React, { useState, useEffect, useRef, useContext, useReducer, useCallback, useMemo } from 'react';

// Context setup
const DemoContext = React.createContext();
const fruits = ['apple', 'banana', 'cherry', 'date', 'elderberry', 'fig', 'grape'];

const useDebounce = (value, delay) => {
    const [debouncedValue, setDebouncedValue] = useState(value);
    useEffect(() => {
        const handler = setTimeout(() => {
            setDebouncedValue(value);
        }, delay);
        return () => {
            clearTimeout(handler);
        };
    }, [value, delay]);
    return debouncedValue;
};

// Reducer setup
function countReducer(state, action) {
    switch (action.type) {
        case 'increment':
            return { count: state.count + 1 };
            case 'decrement':
                return { count: state.count - 1 };
                default:
                    return state;
                }
            }
            
            /**
             * HooksDemo component demonstrates usage of the most common React hooks:
             * - useState: Local state management
             * - useEffect: Side effects (like data fetching, subscriptions)
             * - useRef: Mutable value that persists across renders
             * - useContext: Accessing context values
             * - useReducer: Alternative to useState for complex state logic
             * - useCallback: Memoizing functions
             * - useMemo: Memoizing computed values
            */
function HooksDemo() {
               // useState
    const [name, setName] = useState('react User');
    const [input, setInput] = useState('react User');

    const debouncedText = useDebounce(name, 1000);
    let [curFruits, setCurFruits] = useState(fruits);

    // useEffect
    useEffect(() => {
        document.title = `Hello, ${name}!`;
        console.log(input);
        let str = input;

        if (str.length === 4 || str[str.length - 1] === '-') {
            str = str.substring(0, str.length - 1);
        }

        str = [...str].map((c) => /\d/.test(c) ? c : '').join('');
        let num = str.length;
        if (num >= 3)
            str = "(" + str.substring(0,3) + ")" + str.substring(3);
        if (num > 6)
            str = str.substring(0, 5) + str.substring(5, 8) + "-" + str.substring(8);
        
        setName(str);
        return () => {
            // Cleanup example
            document.title = 'React App';
        };
    }, [input, name]);
    
    // useRef
    const inputRef = useRef();
    
    useEffect(() => {
        // Example of ignored state variable
        console.log("fruit".substring(0, Math.min("fruit".length, name.length)));
        setCurFruits(fruits.filter(fruit => fruit.substring(0, Math.min(fruit.length, name.length)) == name));
    }, [name]);
  // useContext
  const contextValue = useContext(DemoContext);

  // useReducer
  const [state, dispatch] = useReducer(countReducer, { count: 0 });

  // useCallback
  const increment = useCallback(() => dispatch({ type: 'increment' }), []);
  const decrement = useCallback(() => dispatch({ type: 'decrement' }), []);

  // useMemo
  const doubledCount = useMemo(() => state.count * 2, [state.count]);

  return (
    <div className="card colorful-card" style={{ marginTop: '2em' }}>
      <h2>React Hooks Demo</h2>
      <div>
        <label htmlFor="nameInput">Name: </label>
        <input
          id="nameInput"
          ref={inputRef}
          value={name}
          onChange={e => setInput(e.target.value)}
          placeholder="Type your name"
        />
        <div>Debounced Text (useDebounce): {debouncedText}</div>
        <ul>{curFruits.map(fruit => <li key={fruit}>{fruit}</li>)}</ul>
        <button className="colorful-btn" onClick={() => inputRef.current && inputRef.current.focus()}>
          Focus Input (useRef)
        </button>
      </div>
      <div style={{ marginTop: '1em' }}>
        <p>Context Value: <b>{contextValue}</b> (useContext)</p>
      </div>
      <div style={{ marginTop: '1em' }}>
        <button className="colorful-btn" onClick={decrement}>-</button>
        <span style={{ margin: '0 1em' }}>Count: {state.count} (useReducer)</span>
        <button className="colorful-btn" onClick={increment}>+</button>
        <p>Doubled Count: {doubledCount} (useMemo)</p>
      </div>
    </div>
  );
}

// DemoContext provider wrapper for demonstration
export default function HooksDemoWrapper() {
  return (
    <DemoContext.Provider value="Hello from Context!">
      <HooksDemo />
    </DemoContext.Provider>
  );
}

/**
 * Documentation:
 *
 * useState: Lets you add local state to function components.
 * useEffect: Lets you perform side effects in function components.
 * useRef: Lets you access and persist values across renders without causing re-renders.
 * useContext: Lets you access the value of a React context.
 * useReducer: Lets you manage more complex state logic in function components.
 * useCallback: Returns a memoized callback function, useful for passing stable functions to children.
 * useMemo: Returns a memoized value, useful for expensive calculations that depend on specific variables.
 */
